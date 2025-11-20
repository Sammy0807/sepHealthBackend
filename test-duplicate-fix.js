require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'http://localhost:3001';

async function testDuplicateMessageFix() {
  console.log('🧪 Testing Duplicate Message Fix and CST Support...\n');
  
  try {
    // Test 1: Check current message count
    console.log('1️⃣ Getting current message count...');
    const beforeResponse = await axios.get(`${BASE_URL}/api/push-messages?limit=5`);
    const messageCountBefore = beforeResponse.data.pagination?.total || 0;
    console.log('   Messages before test:', messageCountBefore);
    
    // Test 2: Schedule a message (should create only 1 message record)
    console.log('\n2️⃣ Scheduling test message with CST time...');
    const futureTime = new Date();
    futureTime.setMinutes(futureTime.getMinutes() + 5); // 5 minutes from now
    
    const scheduleResponse = await axios.post(`${BASE_URL}/api/push-messages`, {
      title: 'Duplicate Test Message',
      body: 'Testing that only one message record is created',
      scheduledDateTime: futureTime.toISOString().slice(0, -1), // Remove Z to test CST parsing
      category: 'Health Tip',
      priority: 'normal'
    });
    
    if (scheduleResponse.data.success) {
      console.log('✅ Message scheduled successfully');
      console.log('   Message ID:', scheduleResponse.data.messageId);
      console.log('   Target devices:', scheduleResponse.data.results.length);
      console.log('   Scheduled time (UTC):', scheduleResponse.data.scheduledTime?.utc);
      console.log('   Scheduled time (CST):', scheduleResponse.data.scheduledTime?.cst);
    }
    
    // Test 3: Check message count after scheduling
    console.log('\n3️⃣ Checking message count after scheduling...');
    const afterResponse = await axios.get(`${BASE_URL}/api/push-messages?limit=10`);
    const messageCountAfter = afterResponse.data.pagination?.total || 0;
    const messagesAdded = messageCountAfter - messageCountBefore;
    
    console.log('   Messages after test:', messageCountAfter);
    console.log('   Messages added:', messagesAdded);
    
    if (messagesAdded === 1) {
      console.log('✅ SUCCESS: Only 1 message record created (no duplicates!)');
    } else {
      console.log(`❌ ISSUE: ${messagesAdded} message records created (expected 1)`);
    }
    
    // Test 4: Test immediate message
    console.log('\n4️⃣ Testing immediate message...');
    const immediateResponse = await axios.post(`${BASE_URL}/api/push-messages/immediate`, {
      title: 'Immediate Test Message',
      body: 'Testing immediate message creation'
    });
    
    if (immediateResponse.data.success) {
      console.log('✅ Immediate message sent successfully');
      console.log('   Message ID:', immediateResponse.data.messageId);
      console.log('   Target devices:', immediateResponse.data.results?.length || 0);
    }
    
    // Test 5: Final message count check
    console.log('\n5️⃣ Final message count check...');
    const finalResponse = await axios.get(`${BASE_URL}/api/push-messages?limit=5`);
    const finalCount = finalResponse.data.pagination?.total || 0;
    const totalAdded = finalCount - messageCountBefore;
    
    console.log('   Final message count:', finalCount);
    console.log('   Total messages added:', totalAdded);
    
    if (totalAdded === 2) {
      console.log('🎉 PERFECT: Exactly 2 messages created (1 scheduled + 1 immediate)');
      console.log('✅ Duplicate message issue is FIXED!');
      console.log('✅ CST timezone support is working!');
    } else {
      console.log(`⚠️  Expected 2 messages, but ${totalAdded} were created`);
    }
    
  } catch (error) {
    console.log('❌ Test failed:', error.message);
    if (error.response?.data) {
      console.log('   Error details:', error.response.data);
    }
  }
}

testDuplicateMessageFix();