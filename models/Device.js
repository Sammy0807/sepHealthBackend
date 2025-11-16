// Device Model (MongoDB/Mongoose Example)
// No user authentication needed - devices are identified by unique deviceId

const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    sparse: true // Allow null but unique when present
  },
  pushToken: {
    type: String,
    required: true,
    unique: true
  },
  deviceType: {
    type: String,
    enum: ['ios', 'android', 'unknown'],
    default: 'unknown'
  },
  deviceInfo: {
    brand: String,
    modelName: String,
    osName: String,
    osVersion: String,
    deviceName: String
  },
  userId: {
    type: String, // Link to SEPHealth user if available
    sparse: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastTokenUpdate: {
    type: Date,
    default: Date.now
  },
  lastActive: {
    type: Date,
    default: Date.now
  },
  // SEPHealth specific fields
  healthProfile: {
    preferences: [String], // Health topics user is interested in
    conditions: [String],  // Health conditions (if user opted to share)
    lastHealthUpdate: Date
  },
  notificationSettings: {
    enableHealthTips: { type: Boolean, default: true },
    enableReminders: { type: Boolean, default: true },
    enableEmergencyAlerts: { type: Boolean, default: true },
    quietHours: {
      enabled: { type: Boolean, default: false },
      startTime: String, // "22:00"
      endTime: String    // "08:00"
    }
  }
}, {
  timestamps: true
});

// Index for better performance
deviceSchema.index({ pushToken: 1 });
deviceSchema.index({ userId: 1 });
deviceSchema.index({ isActive: 1, lastActive: -1 });

module.exports = mongoose.model('Device', deviceSchema, 'devices');