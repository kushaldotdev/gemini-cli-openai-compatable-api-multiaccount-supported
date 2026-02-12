const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const DOT_DEV_VARS = path.join(__dirname, '.dev.vars');

if (!fs.existsSync(DOT_DEV_VARS)) {
    console.error('.dev.vars file not found! Please create it first.');
    process.exit(1);
}

// Read and parse .dev.vars
const content = fs.readFileSync(DOT_DEV_VARS, 'utf-8');
const lines = content.split(/\r?\n/);
const secrets = {};

lines.forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    
    // Find the first '=' to split key and value
    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) return;
    
    const key = line.substring(0, equalsIndex).trim();
    let value = line.substring(equalsIndex + 1).trim();
    
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
    }

    secrets[key] = value;
});

const KEYS_TO_UPLOAD = [
	"GCP_SERVICE_ACCOUNT",
	"GEMINI_PROJECT_ID",
	"OPENAI_API_KEY",
	"ENABLE_MULTI_ACCOUNT",
	"ENABLE_GEMINI_NATIVE_TOOLS",
	"ENABLE_GOOGLE_SEARCH",
	"ENABLE_URL_CONTEXT"
];

async function uploadSecrets() {
    console.log('Starting secret configuration for Cloudflare Workers...');
    
    for (const key of KEYS_TO_UPLOAD) {
        if (secrets[key]) {
            console.log(`\nUploading secret: ${key}...`);
            await new Promise((resolve, reject) => {
                // Use shell: true for Windows compat
                const child = spawn('npx', ['wrangler', 'secret', 'put', key], {
                    stdio: ['pipe', 'inherit', 'inherit'],
                    shell: true
                });
                
                child.stdin.write(secrets[key]);
                child.stdin.end();
                
                child.on('close', (code) => {
                    if (code === 0) {
                        console.log(`✅ Successfully uploaded ${key}`);
                        resolve();
                    } else {
                        console.error(`❌ Failed to upload ${key}`);
                        // Don't reject, just continue to try others
                        resolve(); 
                    }
                });
                
                child.on('error', (err) => {
                     console.error(`❌ Error uploading ${key}:`, err);
                     resolve();
                });
            });
        } else {
            console.log(`⚠️  Skipping ${key} (value not found in .dev.vars)`);
        }
    }
    console.log('\n✨ Configuration complete!');
}

uploadSecrets().catch(err => console.error('Unexpected error:', err));
