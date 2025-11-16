// Event-Driven Push Notification Server
// Uses Bull queue for scheduled notifications - no polling needed!

const express = require('express');
const cors = require('cors');
const Queue = require('bull');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Device = require('./models/Device');
const Message = require('./models/Message');

// MongoDB connection - Same database as SEPHealth
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required');
  console.error('Please create a .env file with your MongoDB connection string');
  console.error('See .env.example for the required format');
  process.exit(1);
}

mongoose.connect(MONGODB_URI).then(() => {
  console.log('🗄️  Connected to MongoDB (SEPHealth Database)');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
});

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// ===========================================
// BULL QUEUE SETUP
// ===========================================

// Create notification queue (requires Redis)
const notificationQueue = new Queue('scheduled-notifications', {
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    connectTimeout: 60000,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    enableReadyCheck: false
  }
});

// Handle Redis connection errors gracefully
notificationQueue.on('error', (error) => {
  console.error('❌ Queue connection error:', error.message);
});

notificationQueue.on('ready', () => {
  console.log('✅ Redis queue connection established');
});

// Bull queue processor
notificationQueue.process('*', async (job) => {
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
      // Update message status
      await Message.findByIdAndUpdate(message._id, {
        status: 'Delivered',
        deliveredAt: new Date()
      });
      
      console.log('✅ Notification delivered successfully');
      return { success: true, result };
    } else {
      console.log('❌ Push notification failed:', result);
      
      // Update message status
      await Message.findByIdAndUpdate(message._id, {
        status: 'Failed',
        error: result.data?.details?.error || 'Unknown error'
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

// ===========================================
// API ROUTES
// ===========================================

// Device registration
app.post('/api/device/register', async (req, res) => {
  try {
    const { pushToken, platform, appVersion, userId, healthProfile } = req.body;
    
    if (!pushToken) {
      return res.status(400).json({ error: 'Push token is required' });
    }
    
    // Find existing device or create new one
    let device = await Device.findOne({ pushToken });
    
    if (device) {
      // Update existing device
      device.lastActive = new Date();
      device.appVersion = appVersion || device.appVersion;
      device.platform = platform || device.platform;
      device.userId = userId || device.userId;
      device.healthProfile = healthProfile || device.healthProfile;
      await device.save();
    } else {
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
    
    console.log('📱 Device registered:', device.pushToken.substring(0, 20) + '...');
    
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

// Get all messages
app.get('/api/push-messages', async (req, res) => {
  try {
    const { status, limit = 50, skip = 0 } = req.query;
    
    // Build query filter
    let filter = {};
    if (status) {
      filter.status = status;
    }
    
    // Get messages from database with optional filtering
    const messages = await Message.find(filter)
      .sort({ createdAt: -1 }) // Most recent first
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    // Count total messages for pagination
    const totalMessages = await Message.countDocuments(filter);
    
    console.log(`📥 Retrieved ${messages.length} messages from database (total: ${totalMessages})`);
    
    res.json({
      success: true,
      data: messages,
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

// Create and schedule message
app.post('/api/push-messages', async (req, res) => {
  try {
    const messageData = req.body;
    
    // Validate required fields
    if (!messageData.title || !messageData.body || !messageData.scheduledDateTime) {
      return res.status(400).json({ 
        error: 'Missing required fields: title, body, scheduledDateTime' 
      });
    }
    
    // Find device(s) to send to
    let devices;
    if (messageData.deviceId) {
      devices = await Device.find({ _id: messageData.deviceId });
    } else {
      // Send to all devices if no specific device
      devices = await Device.find({ isActive: true });
    }
    
    if (devices.length === 0) {
      return res.status(404).json({ error: 'No active devices found' });
    }
    
    const results = [];
    
    // Create message for each device
    for (const device of devices) {
      // Create message record
      const message = new Message({
        title: messageData.title,
        content: messageData.body, // Use 'content' field as required by schema
        scheduledDateTime: new Date(messageData.scheduledDateTime),
        status: 'Scheduled',
        category: messageData.category || 'Health Tip',
        priority: messageData.priority || 'normal',
        targetAudience: messageData.targetAudience || ['All Users'],
        createdBy: messageData.createdBy || 'System'
      });
      
      await message.save();
      
      const scheduledTime = new Date(messageData.scheduledDateTime);
      const now = new Date();
      const delay = scheduledTime - now;
      
      console.log('🕐 Time validation:');
      console.log('  Scheduled time:', scheduledTime.toISOString());
      console.log('  Current time:', now.toISOString());
      console.log('  Delay (ms):', delay);
      console.log('  Delay (seconds):', Math.round(delay / 1000));
      
      // Allow a small buffer for network latency (5 seconds)
      if (delay < -5000) {
        return res.status(400).json({
          success: false,
          error: `Scheduled time must be in the future. Received: ${scheduledTime.toLocaleString()}, Current: ${now.toLocaleString()}`
        });
      }
      
      // If the time is very close (within 30 seconds), schedule it for 30 seconds from now
      const effectiveDelay = delay < 30000 ? 30000 : delay;
      
      // Add job to queue
      const job = await notificationQueue.add(
        { message: message.toObject() },
        {
          delay: effectiveDelay,
          jobId: message._id.toString(), // Use message ID as job ID
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
        scheduledTime: scheduledTime.toISOString()
      });
    }
    
    res.json({ 
      success: true, 
      results,
      message: `Scheduled ${results.length} notification(s)`
    });
    
  } catch (error) {
    console.error('❌ Message scheduling error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send immediate message (creates only ONE message record, sends to all devices)
app.post('/api/push-messages/immediate', async (req, res) => {
  try {
    const messageData = req.body;
    
    // Validate required fields
    if (!messageData.title || !messageData.body) {
      return res.status(400).json({ 
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
      return res.status(404).json({ error: 'No active devices found' });
    }
    
    // Create ONE message record (not one per device)
    const message = new Message({
      title: messageData.title,
      content: messageData.body, // Use 'content' field as required by schema
      scheduledDateTime: new Date(),
      status: 'Scheduled', // Use valid enum value
      category: messageData.category === 'Test' ? 'Health Tip' : (messageData.category || 'Health Tip'), // Map 'Test' to valid enum
      priority: messageData.priority || 'normal',
      targetAudience: messageData.targetAudience || ['All Users'],
      createdBy: messageData.createdBy || 'System'
    });
    
    await message.save();
    
    const results = [];
    
    // Send to each device but don't create separate message records
    for (const device of devices) {
      // Add job to queue with minimal delay (5 seconds)
      const job = await notificationQueue.add(
        { 
          message: {
            ...message.toObject(),
            deviceId: device._id // Add device ID for processing
          }
        },
        {
          delay: 5000, // 5 second delay for immediate messages
          jobId: `${message._id}-${device._id}`, // Unique job ID per device
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
    
    res.json({ 
      success: true, 
      messageId: message._id, // Single message ID
      results,
      message: `Created 1 message, queued for ${results.length} device(s)`
    });
    
  } catch (error) {
    console.error('❌ Immediate message error:', error);
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

// Get all devices
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await Device.find({})
      .sort({ lastActive: -1 })
      .select('pushToken platform lastActive isActive createdAt');
        
    res.json({
      success: true,
      devices: devices.map(device => ({
        id: device._id,
        pushToken: device.pushToken.substring(0, 20) + '...',
        platform: device.platform,
        lastActive: device.lastActive,
        isActive: device.isActive,
        createdAt: device.createdAt
      })),
      total: devices.length
    });
    
  } catch (error) {
    console.error('❌ Error fetching devices:', error);
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

// Health check
app.get('/api/health', async (req, res) => {
  try {
    // Check MongoDB connection
    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    // Check Redis connection
    let redisStatus = 'disconnected';
    let queueStats = '0 jobs waiting';
    try {
      await notificationQueue.client.ping();
      redisStatus = 'connected';
      const waiting = await notificationQueue.getWaiting();
      queueStats = `${waiting.length} jobs waiting`;
    } catch (redisError) {
      console.error('Redis health check failed:', redisError.message);
    }
    
    const isHealthy = mongoStatus === 'connected' && redisStatus === 'connected';
    
    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
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
      timestamp: new Date().toISOString()
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Push notification server running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Health check: http://0.0.0.0:${PORT}/api/health`);
  console.log('📱 Ready to receive device registrations and schedule notifications!');
});
