#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Runs openclaw onboard --non-interactive to configure from env vars
# 2. Patches config for features onboard doesn't cover (channels, gateway auth)
# 3. Starts the gateway
#
# NOTE: Persistence (backup/restore) is handled by the Sandbox SDK at the
# Worker level, not inside the container. The Worker calls createBackup()
# and restoreBackup() which use squashfs snapshots stored in R2.
# No rclone or R2 credentials are needed inside the container.

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    # Determine auth choice — openclaw onboard reads the actual key values
    # from environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    # so we only pass --auth-choice, never the key itself, to avoid
    # exposing secrets in process arguments visible via ps/proc.
    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');
const path = require('path');

const configPath = '/root/.openclaw/openclaw.json';
const DEFAULT_CF_AI_GATEWAY_MODEL = 'workers-ai/@cf/moonshotai/kimi-k2.6';

console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

const controlUiAllowedOrigins = new Set([
    '*',
    'http://localhost:18789',
    'http://127.0.0.1:18789',
]);
if (process.env.WORKER_URL) {
    try {
        controlUiAllowedOrigins.add(new URL(process.env.WORKER_URL).origin);
    } catch {
        console.warn('WORKER_URL is not a valid URL; skipping Control UI origin seed');
    }
}

config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.enabled = true;
config.gateway.controlUi.allowedOrigins = Array.from(controlUiAllowedOrigins);
config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Allow any origin to connect to the gateway control UI.
// The gateway runs inside a Cloudflare Container behind the Worker, which
// proxies requests from the public workers.dev domain. Without this,
// openclaw >= 2026.2.26 rejects WebSocket connections because the browser's
// origin (https://....workers.dev) doesn't match the gateway's localhost.
// Security is handled by CF Access + gateway token auth, not origin checks.
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = Array.from(controlUiAllowedOrigins);

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model selection (CF_AI_GATEWAY_MODEL=provider/model-id).
// This follows upstream moltworker's override contract, while defaulting this
// fork to Kimi K2.6 on Workers AI when Cloudflare AI Gateway is configured.
// Examples:
//   workers-ai/@cf/moonshotai/kimi-k2.6
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
{
    const raw = (process.env.CF_AI_GATEWAY_MODEL || DEFAULT_CF_AI_GATEWAY_MODEL).trim();
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const selectedModelId = raw.substring(slashIdx + 1);
    const selectedProviderName = 'cf-ai-gw-' + gwProvider;
    const selectedModelRef = selectedProviderName + '/' + selectedModelId;

    if (slashIdx <= 0 || slashIdx === raw.length - 1) {
        console.warn('AI Gateway model must use provider/model-id format; got: ' + raw);
    } else {
        const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
        const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
        const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

        let baseUrl;
        if (accountId && gatewayId) {
            baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
            if (gwProvider === 'workers-ai') baseUrl += '/v1';
        } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
            baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
        }

        if (baseUrl && apiKey) {
            const isKimi26 = raw === DEFAULT_CF_AI_GATEWAY_MODEL;
            const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';

            config.models = config.models || {};
            config.models.providers = config.models.providers || {};
            delete config.models.providers['cloudflare-ai-gateway'];
            delete config.models.providers['cloudflare-ai-gateway-workers-ai'];
            config.models.providers[selectedProviderName] = {
                baseUrl: baseUrl,
                apiKey: apiKey,
                api: api,
                models: [
                    {
                        id: selectedModelId,
                        name: isKimi26 ? 'Kimi K2.6 (Workers AI via Cloudflare AI Gateway)' : selectedModelId,
                        api: api,
                        reasoning: false,
                        contextWindow: isKimi26 ? 262144 : 131072,
                        maxTokens: isKimi26 ? 16384 : 8192,
                        input: ['text'],
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                        },
                    },
                ],
            };

            config.agents = config.agents || {};
            config.agents.defaults = config.agents.defaults || {};
            config.agents.defaults.model = { primary: selectedModelRef, fallbacks: [] };

            const allowedModels = { ...(config.agents.defaults.models || {}) };
            for (const key of Object.keys(allowedModels)) {
                const normalized = key.toLowerCase();
                if (
                    normalized.includes('claude') ||
                    normalized.startsWith('cloudflare-ai-gateway/') ||
                    normalized.startsWith('cf-ai-gw-workers-ai/') ||
                    normalized.startsWith('cloudflare-ai-gateway-workers-ai/')
                ) {
                    delete allowedModels[key];
                }
            }
            allowedModels[selectedModelRef] = {
                ...(allowedModels[selectedModelRef] || {}),
                alias: isKimi26 ? 'Kimi K2.6' : selectedModelId,
            };
            config.agents.defaults.models = allowedModels;

            if (Array.isArray(config.agents.list)) {
                for (const agent of config.agents.list) {
                    if (!agent || typeof agent !== 'object') continue;
                    const currentPrimary = typeof agent.model === 'string' ? agent.model : agent.model?.primary;
                    if (currentPrimary) {
                        agent.model = { primary: selectedModelRef, fallbacks: [] };
                    }
                }
            }

            rewriteStaleSessionModelSelections({
                configDir: path.dirname(configPath),
                provider: selectedProviderName,
                model: selectedModelId,
            });

            console.log('AI Gateway model selected: provider=' + selectedProviderName + ' model=' + selectedModelId + ' via ' + baseUrl);
        } else {
            console.warn('AI Gateway model selected but missing required config (account ID, gateway ID, or API key)');
        }
    }
}

function isStaleClaudeModelRef(value) {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return (
        normalized.includes('claude') ||
        normalized.startsWith('cloudflare-ai-gateway/') ||
        normalized.startsWith('cloudflare-ai-gateway:') ||
        normalized.startsWith('cf-ai-gw-workers-ai/') ||
        normalized.startsWith('cloudflare-ai-gateway-workers-ai/')
    );
}

function rewriteStaleSessionModelSelections({ configDir, provider, model }) {
    const agentsDir = path.join(configDir, 'agents');
    if (!fs.existsSync(agentsDir)) return;

    const sessionStorePaths = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(fullPath);
            } else if (entry.isFile() && entry.name === 'sessions.json') {
                sessionStorePaths.push(fullPath);
            }
        }
    };
    visit(agentsDir);

    let rewrittenStores = 0;
    let rewrittenEntries = 0;
    for (const storePath of sessionStorePaths) {
        let store;
        try {
            store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        } catch (err) {
            console.warn('Could not read session store for model rewrite: ' + storePath + ' (' + String(err) + ')');
            continue;
        }
        if (!store || typeof store !== 'object' || Array.isArray(store)) continue;

        let changed = false;
        for (const entry of Object.values(store)) {
            if (!entry || typeof entry !== 'object') continue;
            const hasExplicitModelSelection =
                typeof entry.providerOverride === 'string' ||
                typeof entry.modelOverride === 'string' ||
                typeof entry.modelProvider === 'string' ||
                typeof entry.model === 'string';
            const stale =
                isStaleClaudeModelRef(entry.providerOverride + '/' + entry.modelOverride) ||
                isStaleClaudeModelRef(entry.modelProvider + '/' + entry.model) ||
                isStaleClaudeModelRef(entry.modelOverride) ||
                isStaleClaudeModelRef(entry.model);
            if (!hasExplicitModelSelection && !stale) continue;

            entry.providerOverride = provider;
            entry.modelOverride = model;
            entry.modelOverrideSource = 'user';
            entry.modelProvider = provider;
            entry.model = model;
            delete entry.authProfileOverride;
            delete entry.authProfileOverrideSource;
            entry.liveModelSwitchPending = true;
            changed = true;
            rewrittenEntries++;
        }

        if (changed) {
            fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
            rewrittenStores++;
        }
    }

    if (rewrittenStores > 0) {
        console.log('Rewrote stale Claude model selections in ' + rewrittenEntries + ' session entries across ' + rewrittenStores + ' stores');
    }
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

# Gateway token (if set) is already written to openclaw.json by the config
# patch above (gateway.auth.token). We deliberately avoid passing --token on
# the command line because CLI arguments are visible to all processes in the
# container via ps/proc.
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
else
    echo "Starting gateway with device pairing (no token)..."
fi
exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
