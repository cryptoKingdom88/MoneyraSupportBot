// Test script to verify embedding storage and similarity detection
const { config } = require('./dist/config/config');
const { DatabaseManager } = require('./dist/dbManager/database');
const { KBManager } = require('./dist/kbManager/kbManager');
const { VectorServiceClient } = require('./dist/vectorService/vectorServiceClient');

async function testEmbeddingStorage() {
  console.log('🧪 Testing Embedding Storage and Similarity Detection...');
  
  try {
    // Initialize database
    const dbManager = new DatabaseManager();
    await dbManager.initialize();
    const db = dbManager.getConnection();
    
    // Initialize vector client
    const vectorConfig = config.getVectorServiceConfig();
    console.log(`Vector service enabled: ${vectorConfig.enabled}`);
    console.log(`Vector service URL: ${vectorConfig.baseUrl}`);
    
    const vectorClient = new VectorServiceClient(vectorConfig);
    
    // Test vector service health
    console.log('🔍 Checking vector service health...');
    const healthCheck = await vectorClient.healthCheck();
    console.log(`Vector service status: ${healthCheck.status}`);
    
    if (healthCheck.status !== 'healthy') {
      console.log('⚠️ Vector service is not healthy, test may not work properly');
      return;
    }
    
    // Initialize KBManager with vector integration
    const kbManager = new KBManager(db, vectorClient);
    
    console.log('\n📝 Test 1: Adding KB entry with embedding storage...');
    
    // Add first entry
    const testCategory = 'Test';
    const testQuestion1 = 'How to reset my password?';
    const testAnswer1 = 'Go to settings and click reset password.';
    
    const entryId1 = await kbManager.addEntryWithAutoContext(testCategory, testQuestion1, testAnswer1);
    console.log(`✅ Added KB entry #${entryId1}: "${testQuestion1}"`);
    
    // Check if embedding was stored in context
    const entry1 = await kbManager.getEntryById(entryId1);
    if (entry1 && entry1.context) {
      try {
        const embedding = JSON.parse(entry1.context);
        if (Array.isArray(embedding) && embedding.length > 0) {
          console.log(`✅ Embedding stored in context field: ${embedding.length} dimensions`);
          console.log(`   First few values: [${embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
        } else {
          console.log(`❌ Context field does not contain valid embedding array`);
        }
      } catch (e) {
        console.log(`❌ Context field is not valid JSON: ${entry1.context.substring(0, 100)}...`);
      }
    } else {
      console.log(`❌ No context field found in entry`);
    }
    
    console.log('\n📝 Test 2: Testing similarity detection with very similar question...');
    
    // Try to add very similar entry
    const testQuestion2 = 'How do I reset my password?';
    const testAnswer2 = 'You can reset your password in the settings menu.';
    
    try {
      const entryId2 = await kbManager.addEntryWithAutoContext(testCategory, testQuestion2, testAnswer2);
      console.log(`❌ ERROR: Similar entry was added when it should have been blocked! ID: ${entryId2}`);
    } catch (error) {
      console.log(`✅ Correctly blocked similar entry: ${error.message}`);
    }
    
    console.log('\n📝 Test 3: Testing similarity check function...');
    
    // Test similarity check with various questions
    const testQuestions = [
      'How can I reset my password?',
      'Password reset instructions',
      'I forgot my password',
      'How to create a new account?',  // Should be different
      'What is the weather today?'     // Should be very different
    ];
    
    for (const question of testQuestions) {
      const similarCheck = await kbManager.findSimilarEntry(question);
      if (similarCheck.hasSimilar && similarCheck.similarEntry) {
        console.log(`🎯 "${question}" -> Similar to ID ${similarCheck.similarEntry.id} (${(similarCheck.similarityScore! * 100).toFixed(1)}%)`);
        console.log(`   Original: "${similarCheck.similarEntry.question}"`);
      } else {
        console.log(`🔍 "${question}" -> No similar entry found`);
      }
    }
    
    console.log('\n📝 Test 4: Adding different entry (should succeed)...');
    
    // Add different entry
    const testQuestion3 = 'How to create a new account?';
    const testAnswer3 = 'Click on sign up button and fill the form.';
    
    try {
      const entryId3 = await kbManager.addEntryWithAutoContext(testCategory, testQuestion3, testAnswer3);
      console.log(`✅ Added different KB entry #${entryId3}: "${testQuestion3}"`);
      
      // Check embedding storage for this entry too
      const entry3 = await kbManager.getEntryById(entryId3);
      if (entry3 && entry3.context) {
        try {
          const embedding = JSON.parse(entry3.context);
          if (Array.isArray(embedding) && embedding.length > 0) {
            console.log(`✅ Embedding stored for entry #${entryId3}: ${embedding.length} dimensions`);
          }
        } catch (e) {
          console.log(`❌ Invalid embedding format for entry #${entryId3}`);
        }
      }
    } catch (error) {
      console.log(`❌ ERROR: Different entry was blocked: ${error.message}`);
    }
    
    console.log('\n📝 Test 5: Testing update with same content (should succeed)...');
    
    // Update same entry with similar content
    try {
      const updated = await kbManager.updateEntryWithAutoContext(entryId1, testCategory, testQuestion1, 'Updated: Go to settings and click reset password button.');
      if (updated) {
        console.log(`✅ Successfully updated entry #${entryId1} with same question`);
        
        // Check if new embedding was generated
        const updatedEntry = await kbManager.getEntryById(entryId1);
        if (updatedEntry && updatedEntry.context) {
          try {
            const embedding = JSON.parse(updatedEntry.context);
            console.log(`✅ New embedding generated for updated entry: ${embedding.length} dimensions`);
          } catch (e) {
            console.log(`❌ Invalid embedding after update`);
          }
        }
      } else {
        console.log(`❌ Failed to update entry #${entryId1}`);
      }
    } catch (error) {
      console.log(`❌ ERROR: Update failed: ${error.message}`);
    }
    
    // Clean up test entries
    console.log('\n🗑️ Cleaning up test entries...');
    const allEntries = await kbManager.getAllEntries();
    for (const entry of allEntries) {
      if (entry.category === 'Test') {
        await kbManager.deleteEntry(entry.id);
        console.log(`🗑️ Deleted test entry #${entry.id}`);
      }
    }
    
    console.log('\n✅ Embedding storage and similarity detection test completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('💡 Make sure the vector service is running on the configured URL');
    }
  }
}

// Run the test
testEmbeddingStorage().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Test execution failed:', error);
  process.exit(1);
});