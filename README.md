# 🚀 Gemini CLI OpenAI Worker

Transform Google's Gemini models into OpenAI-compatible endpoints using Cloudflare Workers. Uses OAuth2 authentication from the official Gemini CLI — no API keys required.

## ✨ Key Features

- 🔐 OAuth2 Auth — uses your Google account, no API keys needed
- 🎯 OpenAI-Compatible — drop-in replacement for `/v1/chat/completions`
- 🔀 Multi-Account Rotation — automatic failover across accounts on rate limits
- 🧠 Thinking Support — native Gemini reasoning with effort controls
- 🖼️ Vision & Tool Calling — images, function calling, Google Search
- ⚡ Edge Deployed — Cloudflare Workers with KV token caching

## 🤖 Supported Models

| Model ID                       | Context | Max Tokens | Thinking |
| ------------------------------ | ------- | ---------- | -------- |
| `gemini-3.1-pro-preview`       | 1M      | 65K        | ✅       | _(default)_
| `gemini-3.1-flash-preview`     | 1M      | 65K        | ✅       |
| `gemini-2.5-pro`               | 1M      | 65K        | ✅       |
| `gemini-2.5-flash`             | 1M      | 65K        | ✅       |
| `gemini-2.5-flash-lite`        | 1M      | 65K        | ✅       |

---

## 🛠️ Setup

### Prerequisites

- **Google Account** with access to Gemini
- **Cloudflare Account** with Workers enabled
- **Node.js** installed

### Step 1: Get OAuth2 Credentials

```bash
# Install Gemini CLI
npm install -g @google/gemini-cli

# Authenticate
gemini
# Select "Login with Google" and complete the browser flow
```

Your credentials are saved at:

- **Windows:** `C:\Users\USERNAME\.gemini\oauth_creds.json`
- **macOS/Linux:** `~/.gemini/oauth_creds.json`

### Step 2: Get Your Project ID

After authenticating, you need your Google Cloud Project ID. You can find it by:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Your Project ID is shown in the project selector at the top
3. It typically looks like `gen-lang-client-XXXXXXXXXX` or a custom name like `my-project-123456`

> **Tip:** If you don't have a project, the Gemini CLI may have auto-created one called `gen-lang-client-XXXXXXXXXX`. Check the Cloud Console.

### Step 3: Clone & Install

```bash
git clone -b copilot/add-multi-account-support https://github.com/kushaldotdev/gemini-cli-openai-compatable-api-multiaccount-supported .
npm install
```

### Step 4: Configure Environment

Create a `.dev.vars` file in the project root.

> **Pro Tip:** You can also create a file named `gcp_service_account.json` in the root directory and paste your JSON credentials there for better readability. The `configure-secrets.js` script will automatically pick it up. See `gcp_service_account.example.json` for the expected format.

#### Single Account Setup

```bash
# Required: OAuth2 credentials (copy contents of oauth_creds.json)
GCP_SERVICE_ACCOUNT={"access_token":"ya29...","refresh_token":"1//...","scope":"...","token_type":"Bearer","id_token":"eyJ...","expiry_date":1750927763467}

# Required: Your Google Cloud Project ID
GEMINI_PROJECT_ID=gen-lang-client-XXXXXXXXXX

# Optional: API key to protect your endpoint (if not set, API is public)
# OPENAI_API_KEY=sk-your-secret-key
```

#### Multi-Account Setup (Rate Limit Avoidance)

To use multiple Google accounts, format `GCP_SERVICE_ACCOUNT` as a JSON **array**. Each account can have its own `project_id`:

```bash
GCP_SERVICE_ACCOUNT=[{"access_token":"ya29...","refresh_token":"1//...","scope":"...","token_type":"Bearer","id_token":"eyJ...","expiry_date":1750927763467,"project_id":"gen-lang-client-111"},{"access_token":"ya29...","refresh_token":"1//...","scope":"...","token_type":"Bearer","id_token":"eyJ...","expiry_date":1750927763467,"project_id":"my-other-project-222"}]

# Required for multi-account
ENABLE_MULTI_ACCOUNT=true

# Fallback Project ID (used if an account doesn't have its own project_id)
GEMINI_PROJECT_ID=gen-lang-client-111
```

**To add accounts:**

1. Delete `~/.gemini/oauth_creds.json`
2. Run `gemini` and log in with the next Google account
3. Copy the new credentials and add them to the array
4. Include `"project_id":"your-project-id"` in each account object

**How rotation works:**

- Accounts rotate round-robin on rate limit errors (429/503)
- Rate-limited accounts cool down for 60 seconds
- Up to 3 retry attempts before failing
- State is stored in Cloudflare KV (works across edge locations)

### Step 5: Create KV Namespace

```bash
npx wrangler kv namespace create "GEMINI_CLI_KV"
```

Copy the returned namespace ID into `wrangler.toml`:

```toml
kv_namespaces = [
  { binding = "GEMINI_CLI_KV", id = "your-namespace-id" }
]
```

### Step 6: Deploy

#### Fresh Deployment

```bash
# Deploy to Cloudflare Workers
npm run deploy

# Push secrets from .dev.vars to Cloudflare
node configure-secrets.js
```

#### Redeployment (After Config Changes)

If you've already deployed and just updated `.dev.vars` (e.g., added accounts):

```bash
# Sync secrets to Cloudflare
node configure-secrets.js

# Redeploy the worker code
npm run deploy
```

#### Local Development

```bash
npm run dev
# Server starts at http://localhost:8787
```

---

## 🔧 Configuration Reference

### Core Variables

| Variable               | Required | Description                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| `GCP_SERVICE_ACCOUNT`  | ✅       | OAuth2 credentials JSON. Single object or array for multi-account. |
| `GEMINI_PROJECT_ID`    | ✅       | Google Cloud Project ID. Fallback if account doesn't specify one.  |
| `OPENAI_API_KEY`       | ❌       | API key to protect your endpoint. If unset, API is public.         |
| `ENABLE_MULTI_ACCOUNT` | ❌       | Set `true` to enable account rotation.                             |

### Thinking & Reasoning

| Variable                     | Description                                               |
| ---------------------------- | --------------------------------------------------------- |
| `ENABLE_REAL_THINKING`       | Use Gemini's native reasoning (`true` to enable)          |
| `ENABLE_FAKE_THINKING`       | Generate synthetic reasoning text (`true` to enable)      |
| `STREAM_THINKING_AS_CONTENT` | Stream reasoning as `<thinking>` tags (DeepSeek R1 style) |

### Feature Flags

| Variable                      | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `ENABLE_AUTO_MODEL_SWITCHING` | Auto fallback from pro → flash on rate limits               |
| `ENABLE_GEMINI_NATIVE_TOOLS`  | Master switch for native tools (Google Search, URL Context) |
| `ENABLE_GOOGLE_SEARCH`        | Enable Google Search tool                                   |
| `ENABLE_URL_CONTEXT`          | Enable URL Context tool                                     |

### Content Safety

| Variable                                        | Values                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `GEMINI_MODERATION_HARASSMENT_THRESHOLD`        | `BLOCK_NONE`, `BLOCK_FEW`, `BLOCK_SOME`, `BLOCK_ONLY_HIGH` |
| `GEMINI_MODERATION_HATE_SPEECH_THRESHOLD`       | Same as above                                              |
| `GEMINI_MODERATION_SEXUALLY_EXPLICIT_THRESHOLD` | Same as above                                              |
| `GEMINI_MODERATION_DANGEROUS_CONTENT_THRESHOLD` | Same as above                                              |

---

## 📜 configure-secrets.js

This script reads your `.dev.vars` file and automatically uploads secrets to Cloudflare Workers. It handles:

- `GCP_SERVICE_ACCOUNT`
- `GEMINI_PROJECT_ID`
- `OPENAI_API_KEY`
- `ENABLE_MULTI_ACCOUNT`
- `ENABLE_GEMINI_NATIVE_TOOLS`
- `ENABLE_GOOGLE_SEARCH`
- `ENABLE_URL_CONTEXT`

```bash
# Run after any .dev.vars change
node configure-secrets.js
```

No need to manually run `wrangler secret put` for each variable anymore.

---

## 💻 Usage

### API Base URL

```
https://your-worker.your-subdomain.workers.dev/v1
```

### List Models

```bash
curl https://your-worker.workers.dev/v1/models
```

### Chat Completion

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### With Thinking

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [{"role": "user", "content": "Explain quantum computing"}],
    "include_reasoning": true,
    "thinking_budget": 1024
  }'
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-worker.workers.dev/v1",
    api_key="sk-your-key"
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Client Integrations

Works with any OpenAI-compatible client:

- **Cline** — Set API Provider to "OpenAI", paste your worker URL
- **Open WebUI** — Add as OpenAI-compatible endpoint
- **LiteLLM** — Set `api_base` to your worker URL

---

## 🚨 Troubleshooting

| Problem                         | Solution                                                                   |
| ------------------------------- | -------------------------------------------------------------------------- |
| **401 Auth Error**              | Check OAuth2 credentials are valid; refresh token may be expired           |
| **Project ID Discovery Failed** | Set `GEMINI_PROJECT_ID` in `.dev.vars` and run `node configure-secrets.js` |
| **Rate Limited (429/503)**      | Enable multi-account rotation or wait for cooldown                         |
| **Token Refresh Failed**        | Re-authenticate with `gemini` CLI and update credentials                   |

### Debug Endpoints

```bash
# Check token cache status
curl https://your-worker.workers.dev/v1/debug/cache

# Test authentication
curl -X POST https://your-worker.workers.dev/v1/token-test
```

---

## 📁 Project Structure

```
├── src/
│   ├── auth.ts          # OAuth2 + multi-account rotation
│   ├── config.ts        # API constants
│   ├── gemini-client.ts # Gemini API client + project discovery
│   ├── models.ts        # Model definitions
│   ├── types.ts         # TypeScript interfaces
│   └── routes/
│       └── openai.ts    # OpenAI-compatible route handlers
├── .dev.vars            # Local environment variables (git-ignored)
├── configure-secrets.js # Automated secret push to Cloudflare
├── wrangler.toml        # Cloudflare Worker config
└── package.json
```

---

## ⚡ Quick Reference

```bash
# Fresh setup
git clone -b copilot/add-multi-account-support https://github.com/kushaldotdev/gemini-cli-openai-compatable-api-multiaccount-supported .
npm install
# Edit .dev.vars with your credentials
npx wrangler kv namespace create "GEMINI_CLI_KV"
# Update wrangler.toml with the KV namespace ID
npm run deploy
node configure-secrets.js

# Update config (after editing .dev.vars)
node configure-secrets.js
npm run deploy

# Local dev
npm run dev

# Add a new account
# 1. Delete ~/.gemini/oauth_creds.json
# 2. Run: gemini (login with new account)
# 3. Add new credentials + project_id to the array in .dev.vars
# 4. Run: node configure-secrets.js && npm run deploy
```
