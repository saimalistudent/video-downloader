/**
 * Plan tiers — defaults for Free plans. Change OMNI_PLAN_TIER when you upgrade.
 */
function cleanEnv(value) {
  let v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

const TIERS = {
  free: {
    label: 'Free',
    download_api: {
      limit: 10000,
      unit: 'lookups / month',
      note: 'Omni yt-dlp download API — tracked from admin events',
    },
    netlify: {
      bandwidth_mb: 102400,
      credits: 300,
      build_minutes: 300,
      storage_gb: 10,
      invocations: 125000,
      unit: 'MB bandwidth / month',
      note: 'Netlify Free — 100 GB bandwidth, 300 credits',
    },
    upstash: {
      storage_mb: 256,
      commands: 500000,
      unit: 'MB storage',
      note: 'Upstash Redis Free — 256 MB max',
    },
    domain: {
      purchased: false,
      note: 'No custom domain — using Netlify subdomain',
    },
  },
  starter: {
    label: 'Starter / Paid',
    download_api: { limit: 100000, unit: 'lookups / month', note: 'Adjust via OMNI_DOWNLOAD_API_LIMIT env' },
    netlify: { bandwidth_mb: 512000, credits: 1000, build_minutes: 1000, storage_gb: 100, invocations: 500000, unit: 'MB bandwidth / month', note: 'Netlify paid tier' },
    upstash: { storage_mb: 1024, commands: 5000000, unit: 'MB storage', note: 'Upstash paid' },
    domain: { purchased: true, note: 'Custom domain active' },
  },
};

function getActiveTier() {
  const tier = cleanEnv(process.env.OMNI_PLAN_TIER || 'free').toLowerCase();
  return TIERS[tier] || TIERS.free;
}

function getTierLabel() {
  return getActiveTier().label;
}

function buildPlanDefinitions() {
  const tier = getActiveTier();
  const now = Date.now();
  const domainName = process.env.DOMAIN_NAME || 'omnidownloader.netlify.app';
  const hasCustomDomain = cleanEnv(process.env.DOMAIN_PURCHASED) === 'true' ||
    (!/\.netlify\.app$/i.test(domainName) && Boolean(process.env.DOMAIN_EXPIRES));

  const downloadLimit = parseFloat(process.env.OMNI_DOWNLOAD_API_LIMIT) ||
    tier.download_api.limit;

  const netlifyBw = parseFloat(process.env.NETLIFY_BANDWIDTH_LIMIT_MB) ||
    tier.netlify.bandwidth_mb;

  const upstashStorageMb = parseFloat(process.env.UPSTASH_STORAGE_LIMIT_MB) ||
    tier.upstash.storage_mb;

  const backendUrl = process.env.OMNI_BACKEND_URL || 'https://spontaneous-salamander-418289.netlify.app';

  return [
    {
      plan_id: 'download-api',
      name: 'Omni Download API',
      provider: 'omni-ytdlp',
      used: 0,
      limit_value: downloadLimit,
      unit: tier.download_api.unit,
      tier: getTierLabel(),
      meta: {
        backend_url: backendUrl,
        note: tier.download_api.note,
        auto_tier: cleanEnv(process.env.OMNI_PLAN_TIER || 'free'),
      },
      updated_at: now,
    },
    {
      plan_id: 'netlify',
      name: 'Netlify Hosting',
      provider: 'netlify',
      used: 0,
      limit_value: netlifyBw,
      unit: tier.netlify.unit,
      tier: getTierLabel(),
      meta: {
        site: process.env.NETLIFY_SITE_ID || '',
        credits: tier.netlify.credits,
        build_minutes: tier.netlify.build_minutes,
        storage_gb: tier.netlify.storage_gb,
        invocations: tier.netlify.invocations,
        note: tier.netlify.note,
        auto_tier: cleanEnv(process.env.OMNI_PLAN_TIER || 'free'),
      },
      updated_at: now,
    },
    {
      plan_id: 'upstash',
      name: 'Upstash Redis (Admin Data)',
      provider: 'upstash',
      used: 0,
      limit_value: upstashStorageMb,
      unit: tier.upstash.unit,
      tier: getTierLabel(),
      meta: {
        commands_limit: tier.upstash.commands,
        note: tier.upstash.note,
        auto_tier: cleanEnv(process.env.OMNI_PLAN_TIER || 'free'),
      },
      updated_at: now,
    },
    {
      plan_id: 'domain',
      name: domainName,
      provider: 'domain',
      used: 0,
      limit_value: 0,
      unit: '',
      tier: getTierLabel(),
      meta: {
        registrar: process.env.DOMAIN_REGISTRAR || 'Not purchased yet',
        expires: process.env.DOMAIN_EXPIRES || '',
        purchased: hasCustomDomain,
        note: hasCustomDomain ? 'Custom domain' : tier.domain.note,
        auto_tier: cleanEnv(process.env.OMNI_PLAN_TIER || 'free'),
      },
      updated_at: now,
    },
  ];
}

module.exports = {
  TIERS,
  getActiveTier,
  getTierLabel,
  buildPlanDefinitions,
};
