// Event-Driven Push Notification Server
// Uses Bull queue for scheduled notifications - no polling needed!

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Queue = require('bull');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Device = require('./models/Device');
const Message = require('./models/Message');

// MongoDB connection - Same database as SEPHealth
let MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required');
  console.error('Please create a .env file with your MongoDB connection string');
  console.error('See .env.example for the required format');
  process.exit(1);
}

// Normalize database name to lowercase to avoid case-sensitivity issues (e.g., sepHealth vs sephealth)
if (MONGODB_URI.includes('?')) {
  const [base, query] = MONGODB_URI.split('?');
  const lastSlashIndex = base.lastIndexOf('/');
  if (lastSlashIndex !== -1 && lastSlashIndex < base.length - 1) {
    MONGODB_URI = base.substring(0, lastSlashIndex + 1) + base.substring(lastSlashIndex + 1).toLowerCase() + '?' + query;
  }
} else {
  const lastSlashIndex = MONGODB_URI.lastIndexOf('/');
  if (lastSlashIndex !== -1 && lastSlashIndex < MONGODB_URI.length - 1) {
    MONGODB_URI = MONGODB_URI.substring(0, lastSlashIndex + 1) + MONGODB_URI.substring(lastSlashIndex + 1).toLowerCase();
  }
}

mongoose.connect(MONGODB_URI).then(() => {
  console.log('🗄️  Connected to MongoDB (SEPHealth Database)');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Socket.io connection logging
io.on('connection', (socket) => {
  console.log(`🔌 Client connected to Socket.io: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// ===========================================
// BULL QUEUE SETUP
// ===========================================

// Create Redis connection string for Cloud instance
const REDIS_URL = process.env.REDIS_URL || 'redis://default:VmppE6apMWIol0gVMJtWJIBQvhKigbaN@redis-19292.c240.us-east-1-3.ec2.cloud.redislabs.com:19292';

const notificationQueue = new Queue('scheduled-notifications', REDIS_URL, {
  redis: {
    connectTimeout: 20000,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  },
  settings: {
    lockDuration: 60000,
    stalledInterval: 60000
  }
});

// Monitor connection state every 10 seconds
setInterval(async () => {
  try {
    const isReady = notificationQueue.client.status === 'ready';
    const waitingCount = await notificationQueue.getWaitingCount();
    const delayedCount = await notificationQueue.getDelayedCount();
    console.log(`[Queue Monitor] Redis: ${notificationQueue.client.status} | Jobs: ${waitingCount} waiting, ${delayedCount} delayed`);
  } catch (err) {
    console.log(`[Queue Monitor] Error: ${err.message}`);
  }
}, 10000);

// Immediate connection test
console.log('📡 Testing Redis connection...');
notificationQueue.client.ping().then(() => {
  console.log('✅ REDIS CONNECTED: Server is reachable');
}).catch(err => {
  console.error('❌ REDIS CONNECTION FAILED:', err.message);
  console.log('👉 CRITICAL: Push notifications will NOT work without Redis.');
  console.log('👉 Please install Redis or start it with: `docker run -p 6379:6379 redis`');
});

// Handle Redis connection events explicitly
notificationQueue.on('error', (error) => {
  console.error('❌ REDIS ERROR:', error.message);
  console.log('👉 Hint: Make sure Redis is installed and running (`redis-server`)');
});

notificationQueue.on('waiting', (jobId) => {
  // console.log(`🕒 Job ${jobId} is waiting in the queue`);
});

notificationQueue.on('ready', () => {
  console.log('✅ REDIS STATUS: Connected and Ready');
});

notificationQueue.on('reconnecting', () => {
  console.log('🔄 REDIS STATUS: Reconnecting...');
});

// Bull queue processor (using default processor for simple queuing)
notificationQueue.process(async (job) => {
  try {
    const { message } = job.data;
    console.log('\n🚀 Processing scheduled notification:', message.title);

    // Find the device for this message (deviceId might be in message object for immediate messages)
    const deviceId = message.deviceId || message._id;
    const device = await Device.findById(deviceId);
    if (!device) {
      console.log('❌ Device not found for message:', message._id, 'deviceId:', deviceId);
      return { success: false, error: 'Device not found' };
    }

    // Prepare push notification payload
    const pushMessage = {
      to: device.pushToken,
      sound: 'default',
      title: message.title,
      body: message.body,
      data: {
        messageId: message._id,
        category: message.category,
        ...message.data
      }
    };

    console.log('📤 Sending push notification to:', device.pushToken.substring(0, 20) + '...');

    // Send to Expo Push API
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pushMessage)
    });

    const result = await response.json();

    if (result.data && result.data.status === 'ok') {
      // Update message status - The polling workaround expects 'Sent'
      const updatedMsg = await Message.findByIdAndUpdate(message._id, {
        status: 'Sent',
        deliveredAt: new Date()
      }, { new: true });

      // Emit real-time update
      io.emit('statusUpdate', {
        messageId: message._id,
        status: 'Sent',
        deliveredAt: updatedMsg.deliveredAt
      });

      console.log(`✨ SUCCESS: Message "${message.title}" (ID: ${message._id}) marked as Sent`);
      return { success: true, result };
    } else {
      console.log(`❌ ERROR: Push API failed for message ${message._id}:`, JSON.stringify(result));

      // Update message status
      const updatedMsg = await Message.findByIdAndUpdate(message._id, {
        status: 'Failed',
        error: result.data?.details?.error || (result.errors && result.errors[0]?.message) || 'Unknown error'
      }, { new: true });

      // Emit real-time update
      io.emit('statusUpdate', {
        messageId: message._id,
        status: 'Failed',
        error: updatedMsg.error
      });

      return { success: false, error: result };
    }

  } catch (error) {
    console.error('❌ Queue processing error:', error);
    throw error;
  }
});

// Queue event listeners
notificationQueue.on('completed', (job, result) => {
  console.log(`✅ Job ${job.id} completed:`, result);
});

notificationQueue.on('failed', (job, err) => {
  console.log(`❌ Job ${job.id} failed:`, err.message);
});

notificationQueue.on('active', (job) => {
  console.log(`🏃 Job ${job.id} started processing...`);
});

notificationQueue.on('stalled', (job) => {
  console.log(`⚠️ Job ${job.id} has stalled!`);
});

// ===========================================
// API ROUTES
// ===========================================

// Device registration
app.post('/api/device/register', async (req, res) => {
  console.log('📬 Received registration request at /api/device/register');
  try {
    const { pushToken, platform, appVersion, userId, healthProfile } = req.body;
    console.log('📦 Registration payload:', JSON.stringify(req.body, null, 2));

    if (!pushToken) {
      return res.status(400).json({ error: 'Push token is required' });
    }

    console.log('📱 Registration request received:', { pushToken, platform, appVersion, userId });

    // Find existing device or create new one
    let device = await Device.findOne({ pushToken });

    if (device) {
      console.log('🔄 Updating existing device:', device._id);
      // Update existing device
      device.lastActive = new Date();
      device.appVersion = appVersion || device.appVersion;
      device.platform = platform || device.platform;
      device.userId = userId || device.userId;
      device.healthProfile = healthProfile || device.healthProfile;
      await device.save();
    } else {
      console.log('✨ Creating new device registration');
      // Create new device
      device = new Device({
        pushToken,
        platform: platform || 'unknown',
        appVersion: appVersion || '1.0.0',
        userId: userId || null,
        healthProfile: healthProfile || {}
      });
      await device.save();
    }

    console.log('✅ Device registered successfully:', device._id);

    res.json({
      success: true,
      deviceId: device._id,
      message: 'Device registered successfully'
    });

  } catch (error) {
    console.error('❌ Device registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create and schedule message
app.post('/api/push-messages', async (req, res) => {
  try {
    const messageData = req.body;
    console.log("Scheduled date and time (CST):", messageData.scheduledDateTime);

    // Validate required fields
    if (!messageData.title || !messageData.body || !messageData.scheduledDateTime) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: title, body, scheduledDateTime'
      });
    }

    // Convert and validate scheduled datetime
    const cstConversion = convertToCST(messageData.scheduledDateTime);

    if (!cstConversion.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid datetime format',
        details: cstConversion.error,
        hint: 'Use ISO format: YYYY-MM-DDTHH:mm:ss (will be treated as CST time)'
      });
    }

    const scheduledTime = cstConversion.utcDate;
    const now = new Date();
    const delay = scheduledTime - now;

    console.log('⏰ Scheduling Calculation:');
    console.log(`   - Scheduled (UTC): ${scheduledTime.toISOString()}`);
    console.log(`   - Server Now (UTC): ${now.toISOString()}`);
    console.log(`   - Raw Delay: ${delay}ms (${(delay / 1000 / 60).toFixed(2)} minutes)`);

    // Validate scheduled time is in the future
    if (delay < -10000) { // Allow 10s grace for network latency
      console.log('❌ Rejecting: Scheduled time is in the past');
      return res.status(400).json({
        success: false,
        error: 'Scheduled time must be in the future',
        details: {
          scheduled: cstConversion.cstString,
          current: now.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
          serverUtc: now.toISOString(),
          scheduledUtc: scheduledTime.toISOString()
        }
      });
    }

    // Find device(s) to send to
    let devices;
    if (messageData.deviceId) {
      devices = await Device.find({ _id: messageData.deviceId });
    } else {
      devices = await Device.find({ isActive: true });
    }

    if (devices.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No active devices found'
      });
    }

    const results = [];

    // Create ONE message record (not one per device)
    const message = new Message({
      title: messageData.title,
      content: messageData.body,
      scheduledDateTime: scheduledTime, // Store the time as-is
      status: 'Scheduled',
      category: messageData.category || 'Health Tip',
      priority: messageData.priority || 'normal',
      targetAudience: messageData.targetAudience || ['All Users'],
      createdBy: messageData.createdBy || 'System'
    });

    await message.save();

    // Create job for each device
    for (const device of devices) {
      const effectiveDelay = delay < 1000 ? 1000 : delay;
      console.log(`⏳ Notification for device ${device._id} queued with ${effectiveDelay}ms delay`);

      const job = await notificationQueue.add(
        {
          message: {
            ...message.toObject(),
            deviceId: device._id
          }
        },
        {
          delay: effectiveDelay,
          jobId: `${message._id}-${device._id}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: false,
          removeOnFail: false
        }
      );

      results.push({
        messageId: message._id,
        jobId: job.id,
        deviceId: device._id,
        scheduledTime: formatDateTime(scheduledTime)
      });
    }

    res.json({
      success: true,
      messageId: message._id,
      results,
      message: `Created 1 message, scheduled for ${results.length} device(s)`,
      scheduledTime: formatDateTime(scheduledTime)
    });

  } catch (error) {
    console.error('❌ Message scheduling error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Send immediate message
app.post('/api/push-messages/immediate', async (req, res) => {
  try {
    const messageData = req.body;

    // Validate required fields
    if (!messageData.title || !messageData.body) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: title, body'
      });
    }

    // Find device(s) to send to
    let devices;
    if (messageData.deviceId) {
      devices = await Device.find({ _id: messageData.deviceId });
    } else {
      devices = await Device.find({ isActive: true });
    }

    if (devices.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No active devices found'
      });
    }

    // Create ONE message record
    const now = new Date();
    const message = new Message({
      title: messageData.title,
      content: messageData.body,
      scheduledDateTime: now,
      status: 'Scheduled',
      category: messageData.category === 'Test' ? 'Health Tip' : (messageData.category || 'Health Tip'),
      priority: messageData.priority || 'normal',
      targetAudience: messageData.targetAudience || ['All Users'],
      createdBy: messageData.createdBy || 'System'
    });

    await message.save();

    const results = [];

    // Send to each device
    for (const device of devices) {
      const job = await notificationQueue.add(
        {
          message: {
            ...message.toObject(),
            deviceId: device._id
          }
        },
        {
          delay: 5000,
          jobId: `${message._id}-${device._id}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          }
        }
      );

      results.push({
        messageId: message._id,
        jobId: job.id,
        deviceId: device._id
      });
    }

    console.log(`✅ Immediate message created: ${message.title}`);
    console.log(`📱 Queued for ${results.length} device(s) at ${formatDateTime(now)}`);

    res.json({
      success: true,
      messageId: message._id,
      results,
      message: `Created 1 message, queued for ${results.length} device(s)`,
      sentTime: formatDateTime(now)
    });

  } catch (error) {
    console.error('❌ Immediate message error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all messages (with CST times)
app.get('/api/push-messages', async (req, res) => {
  try {
    const { status, limit = 50, skip = 0 } = req.query;

    let filter = {};
    if (status && status !== 'all') {
      filter.status = status;
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const totalMessages = await Message.countDocuments(filter);

    // Format messages with CST times
    const formattedMessages = messages.map(msg => ({
      ...msg.toObject(),
      scheduledDateTime: formatDateTime(msg.scheduledDateTime),
      createdAt: formatDateTime(msg.createdAt),
      ...(msg.cancelledAt && { cancelledAt: formatDateTime(msg.cancelledAt) }),
      ...(msg.deliveredAt && { deliveredAt: formatDateTime(msg.deliveredAt) })
    }));

    console.log(`📥 Retrieved ${messages.length} messages (total: ${totalMessages})`);

    res.json({
      success: true,
      data: formattedMessages,
      pagination: {
        total: totalMessages,
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: (parseInt(skip) + parseInt(limit)) < totalMessages
      }
    });

  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all devices (with CST times)
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await Device.find({})
      .sort({ lastActive: -1 })
      .select('pushToken platform lastActive isActive createdAt');

    const formattedDevices = devices.map(device => ({
      id: device._id,
      pushToken: device.pushToken.substring(0, 20) + '...',
      platform: device.platform,
      lastActive: formatDateTime(device.lastActive),
      isActive: device.isActive,
      createdAt: formatDateTime(device.createdAt)
    }));

    res.json({
      success: true,
      devices: formattedDevices,
      total: devices.length
    });

  } catch (error) {
    console.error('❌ Error fetching devices:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get message stats
app.get('/api/push-messages/stats', async (req, res) => {
  try {
    const stats = await Message.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const deviceCount = await Device.countDocuments({ isActive: true });

    res.json({
      success: true,
      stats: {
        devices: deviceCount,
        messages: stats.reduce((acc, stat) => {
          acc[stat._id.toLowerCase()] = stat.count;
          return acc;
        }, {})
      }
    });

  } catch (error) {
    console.error('❌ Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clean up duplicate/old devices
app.delete('/api/devices/cleanup', async (req, res) => {
  try {
    // Keep only the most recent device per platform
    const devices = await Device.find({}).sort({ lastActive: -1 });
    const platformMap = new Map();
    const devicesToKeep = [];
    const devicesToRemove = [];

    devices.forEach(device => {
      if (!platformMap.has(device.platform)) {
        platformMap.set(device.platform, device);
        devicesToKeep.push(device);
      } else {
        devicesToRemove.push(device);
      }
    });

    // Remove duplicate devices
    if (devicesToRemove.length > 0) {
      const removeIds = devicesToRemove.map(d => d._id);
      await Device.deleteMany({ _id: { $in: removeIds } });

      console.log(`🧹 Cleaned up ${devicesToRemove.length} duplicate devices`);
      console.log(`📱 Keeping ${devicesToKeep.length} devices (one per platform)`);
    }

    res.json({
      success: true,
      message: `Cleaned up ${devicesToRemove.length} duplicate devices`,
      devicesRemoved: devicesToRemove.length,
      devicesRemaining: devicesToKeep.length,
      keptDevices: devicesToKeep.map(d => ({
        platform: d.platform,
        lastActive: d.lastActive
      }))
    });

  } catch (error) {
    console.error('❌ Device cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove all devices (nuclear option)
app.delete('/api/devices/all', async (req, res) => {
  try {
    const result = await Device.deleteMany({});

    console.log(`🗑️  Removed all ${result.deletedCount} devices`);

    res.json({
      success: true,
      message: `Removed all ${result.deletedCount} devices`,
      deletedCount: result.deletedCount
    });

  } catch (error) {
    console.error('❌ Error removing devices:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug registration manually
app.get('/api/debug/register-test', async (req, res) => {
  try {
    const testDevice = new Device({
      pushToken: 'TestToken-' + Date.now(),
      platform: 'unknown',
      isActive: true
    });
    await testDevice.save();
    res.json({ success: true, message: 'Test device registered via debug endpoint', device: testDevice });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check (with CST times)
app.get('/api/health', async (req, res) => {
  try {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

    let redisStatus = 'disconnected';
    let queueStats = '0 jobs waiting';
    try {
      await notificationQueue.client.ping();
      redisStatus = 'connected';
      const waiting = await notificationQueue.getWaitingCount();
      const delayed = await notificationQueue.getDelayedCount();
      queueStats = `${waiting} waiting, ${delayed} delayed`;
    } catch (redisError) {
      console.error('Redis health check failed:', redisError.message);
    }

    const isHealthy = mongoStatus === 'connected' && redisStatus === 'connected';

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: formatDateTime(new Date()),
      server: 'Bull Queue Push Notification Server',
      version: '1.0.0',
      services: {
        mongodb: mongoStatus,
        redis: redisStatus,
        queue: queueStats
      },
      environment: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 3001
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: formatDateTime(new Date())
    });
  }
});

// Delete/Cancel a message
app.delete('/api/push-messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Validate messageId
    if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid message ID provided'
      });
    }

    // Find the message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }

    // Check if message can be cancelled
    const canCancel = ['Scheduled', 'Pending'].includes(message.status);
    const isDelivered = ['Delivered', 'Sent'].includes(message.status);

    // Try to remove job from queue if it's scheduled
    if (canCancel) {
      try {
        // Remove job from Bull queue
        const job = await notificationQueue.getJob(messageId);
        if (job) {
          await job.remove();
          console.log(`🗑️  Removed job ${messageId} from queue`);
        }

        // Also try to find jobs with device-specific IDs (for immediate messages)
        const devices = await Device.find({ isActive: true });
        for (const device of devices) {
          const deviceJobId = `${messageId}-${device._id}`;
          const deviceJob = await notificationQueue.getJob(deviceJobId);
          if (deviceJob) {
            await deviceJob.remove();
            console.log(`🗑️  Removed device job ${deviceJobId} from queue`);
          }
        }

        // Update message status to cancelled
        message.status = 'Cancelled';
        message.cancelledAt = new Date();
        await message.save();

        console.log(`✅ Message cancelled: ${message.title}`);

        res.json({
          success: true,
          message: 'Message cancelled successfully',
          data: {
            messageId: message._id,
            title: message.title,
            status: message.status,
            cancelledAt: message.cancelledAt
          }
        });

      } catch (queueError) {
        console.error('❌ Error removing job from queue:', queueError);

        // Still update the message status even if queue removal fails
        message.status = 'Cancelled';
        message.cancelledAt = new Date();
        await message.save();

        res.json({
          success: true,
          message: 'Message cancelled (queue removal failed but message marked as cancelled)',
          warning: 'Job may still exist in queue',
          data: {
            messageId: message._id,
            title: message.title,
            status: message.status,
            cancelledAt: message.cancelledAt
          }
        });
      }

    } else if (isDelivered) {
      // For delivered messages, just remove from database
      await Message.findByIdAndDelete(messageId);

      console.log(`🗑️  Deleted delivered message: ${message.title}`);

      res.json({
        success: true,
        message: 'Delivered message deleted successfully',
        data: {
          messageId: messageId,
          title: message.title,
          wasDelivered: true
        }
      });

    } else {
      // For failed or other status messages, just delete
      await Message.findByIdAndDelete(messageId);

      console.log(`🗑️  Deleted message: ${message.title} (status: ${message.status})`);

      res.json({
        success: true,
        message: 'Message deleted successfully',
        data: {
          messageId: messageId,
          title: message.title,
          previousStatus: message.status
        }
      });
    }

  } catch (error) {
    console.error('❌ Error deleting message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Bulk delete messages
app.delete('/api/push-messages', async (req, res) => {
  try {
    const { messageIds, status, olderThan } = req.body;

    let deleteFilter = {};

    if (messageIds && Array.isArray(messageIds)) {
      // Delete specific messages by IDs
      deleteFilter._id = { $in: messageIds };
    } else if (status) {
      // Delete by status
      deleteFilter.status = status;
    } else if (olderThan) {
      // Delete messages older than specified date
      deleteFilter.createdAt = { $lt: new Date(olderThan) };
    } else {
      return res.status(400).json({
        success: false,
        error: 'Must provide messageIds, status, or olderThan parameter'
      });
    }

    // Find messages to delete (for queue cleanup)
    const messagesToDelete = await Message.find(deleteFilter);

    // Remove jobs from queue for scheduled messages
    let queueJobsRemoved = 0;
    for (const message of messagesToDelete) {
      if (['Scheduled', 'Pending'].includes(message.status)) {
        try {
          const job = await notificationQueue.getJob(message._id.toString());
          if (job) {
            await job.remove();
            queueJobsRemoved++;
          }
        } catch (queueError) {
          console.warn(`⚠️  Could not remove job ${message._id} from queue:`, queueError.message);
        }
      }
    }

    // Delete messages from database
    const deleteResult = await Message.deleteMany(deleteFilter);

    console.log(`🗑️  Bulk deleted ${deleteResult.deletedCount} messages, removed ${queueJobsRemoved} queue jobs`);

    res.json({
      success: true,
      message: `Successfully deleted ${deleteResult.deletedCount} messages`,
      data: {
        deletedCount: deleteResult.deletedCount,
        queueJobsRemoved: queueJobsRemoved,
        filter: deleteFilter
      }
    });

  } catch (error) {
    console.error('❌ Error bulk deleting messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===========================================
// UTILITY FUNCTIONS
// ===========================================

/**
 * Convert a datetime string to UTC for storage
 * Assumes input without timezone info is in CST
 * @param {string} dateTimeString - ISO datetime string (assumed CST if no timezone)
 * @returns {object} { utcDate, cstString }
 */
function convertToCST(dateTimeString) {
  try {
    let processedString = dateTimeString.trim();
    
    // Check if timezone info exists
    const hasTimezoneInfo = /Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(processedString);
    
    let inputDate;
    
    if (!hasTimezoneInfo) {
      // No timezone info - treat as CST (America/Chicago)
      // Parse the datetime components and create as CST
      const match = processedString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      if (!match) {
        throw new Error('Invalid datetime format. Expected: YYYY-MM-DDTHH:mm:ss');
      }
      
      const [, year, month, day, hour, minute, second] = match;
      
      // Create date in CST timezone (UTC-6 for standard time, UTC-5 for daylight saving)
      // Using a library would be better, but for now we'll add CST offset
      processedString += '-06:00'; // CST offset
    }
    
    inputDate = new Date(processedString);
    if (isNaN(inputDate.getTime())) {
      throw new Error('Invalid date/time value');
    }

    // Always calculate CST string for display purposes (Central Time)
    const cstString = inputDate.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });

    return {
      utcDate: inputDate,
      cstString: cstString,
      isValid: true
    };
  } catch (error) {
    return {
      isValid: false,
      error: error.message
    };
  }
}

/**
 * Format datetime for API responses
 * @param {Date} date - Date object to format
 * @returns {string} ISO datetime string
 */
function formatDateTime(date) {
  if (!date) return null;
  // Always return ISO string for the frontend to parse
  return date.toISOString();
}

// Keep-alive ping (prevents server sleep on free tier)
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      await fetch('https://sephealthbackend.onrender.com/api/health');
      console.log('⏰ Keep-alive ping sent');
    } catch (error) {
      console.error('Keep-alive ping failed:', error.message);
    }
  }, 14 * 60 * 1000); // Ping every 14 minutes
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  const ips = [];

  Object.keys(networkInterfaces).forEach((ifname) => {
    networkInterfaces[ifname].forEach((iface) => {
      if ('IPv4' === iface.family && !iface.internal) {
        ips.push(iface.address);
      }
    });
  });

  console.log(`🚀 Push notification server running with Socket.io on:`);
  console.log(`   🏠 Local:   http://localhost:${PORT}`);
  ips.forEach(ip => {
    console.log(`   🌐 Network: http://${ip}:${PORT}`);
  });
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log('📱 Ready to receive device registrations and schedule notifications!');
});
