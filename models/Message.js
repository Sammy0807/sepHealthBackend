const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    maxlength: 100
  },
  content: {
    type: String,
    required: true,
    maxlength: 500
  },
  scheduledDateTime: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['Draft', 'Scheduled', 'Sent', 'Failed', 'Cancelled'],
    default: 'Scheduled'
  },
  category: {
    type: String,
    enum: ['Health Tip', 'Appointment Reminder', 'System Update', 'Emergency Alert', 'Wellness Check'],
    default: 'Health Tip'
  },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },
  targetAudience: {
    type: [String],
    default: ['All Users']
  },
  recipients: {
    type: Number,
    default: 0
  },
  deliveredCount: {
    type: Number,
    default: 0
  },
  deliveryRate: {
    type: String,
    default: '0%'
  },
  createdBy: {
    type: String,
    default: 'System'
  },
  sentAt: Date,
  errorMessage: String,
  // SEPHealth specific fields
  healthCategory: {
    type: String,
    enum: ['Nutrition', 'Exercise', 'Mental Health', 'Medication', 'Preventive Care', 'General'],
    default: 'General'
  },
  actionRequired: {
    type: Boolean,
    default: false
  },
  expiresAt: Date, // For time-sensitive messages
  // Analytics
  clickCount: {
    type: Number,
    default: 0
  },
  dismissCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index for better performance
messageSchema.index({ scheduledDateTime: 1, status: 1 });
messageSchema.index({ category: 1 });
messageSchema.index({ status: 1 });
messageSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema, 'messages');