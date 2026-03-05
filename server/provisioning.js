// =============== MYCELIUM — Customer Instance Provisioning ===============
// Standalone module. No imports from existing codebase.
// Railway GraphQL API + Cloudflare DNS API + health polling.
// Uses Node 18+ built-in fetch().

var RAILWAY_API = 'https://backboard.railway.app/graphql/v2';
var CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

// ---- Railway GraphQL helpers ----

async function railwayQuery(token, query, variables) {
  var res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error('Railway API ' + res.status + ': ' + text);
  }
  var json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error('Railway GraphQL: ' + json.errors.map(function (e) { return e.message; }).join(', '));
  }
  return json.data;
}

// ---- Cloudflare DNS helpers ----

async function cloudflareRequest(token, method, path, body) {
  var opts = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    }
  };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(CLOUDFLARE_API + path, opts);
  var json = await res.json();
  if (!json.success) {
    var msgs = (json.errors || []).map(function (e) { return e.message; }).join(', ');
    throw new Error('Cloudflare API: ' + (msgs || 'unknown error'));
  }
  return json.result;
}

// =============== Exported Functions ===============

/**
 * Create a new Railway service from a template project.
 * Deploys the Mycelium server image into a new service within an existing project,
 * or creates a new project entirely.
 *
 * @param {object} opts
 * @param {string} opts.railwayToken - Railway API token
 * @param {string} opts.projectId - Existing Railway project ID (if reusing)
 * @param {string} opts.templateId - Source template/repo to deploy from (optional)
 * @param {string} opts.repoUrl - GitHub repo URL to deploy (e.g. SoftBacon-Software/mycelium)
 * @param {string} opts.serviceName - Name for the new service
 * @param {string} opts.environmentId - Railway environment ID
 * @param {object} opts.envVars - Environment variables to set on the service
 * @returns {Promise<{projectId: string, serviceId: string, environmentId: string}>}
 */
export async function createRailwayInstance(opts) {
  var token = opts.railwayToken;
  if (!token) throw new Error('railwayToken is required');

  var projectId = opts.projectId;
  var environmentId = opts.environmentId;

  // If no project, create one
  if (!projectId) {
    var createProject = await railwayQuery(token, `
      mutation($name: String!) {
        projectCreate(input: { name: $name }) {
          id
          environments { edges { node { id name } } }
        }
      }
    `, { name: opts.serviceName || 'mycelium-customer' });
    projectId = createProject.projectCreate.id;
    var envEdges = createProject.projectCreate.environments.edges;
    if (envEdges.length > 0) {
      environmentId = envEdges[0].node.id;
    }
  }

  // Create a service from GitHub repo
  var createService = await railwayQuery(token, `
    mutation($projectId: String!, $name: String, $source: ServiceSourceInput) {
      serviceCreate(input: {
        projectId: $projectId,
        name: $name,
        source: $source
      }) {
        id
        name
      }
    }
  `, {
    projectId: projectId,
    name: opts.serviceName || 'mycelium',
    source: opts.repoUrl ? { repo: opts.repoUrl } : undefined
  });

  var serviceId = createService.serviceCreate.id;

  // Set environment variables if provided
  if (opts.envVars && Object.keys(opts.envVars).length > 0 && environmentId) {
    await railwayQuery(token, `
      mutation($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `, {
      input: {
        projectId: projectId,
        environmentId: environmentId,
        serviceId: serviceId,
        variables: opts.envVars
      }
    });
  }

  return {
    projectId: projectId,
    serviceId: serviceId,
    environmentId: environmentId
  };
}

/**
 * Create a CNAME record in Cloudflare DNS pointing a subdomain to the Railway service.
 *
 * @param {object} opts
 * @param {string} opts.cloudflareToken - Cloudflare API token
 * @param {string} opts.zoneId - Cloudflare zone ID for the domain
 * @param {string} opts.subdomain - Subdomain to create (e.g. "acme" for acme.mycelium.fyi)
 * @param {string} opts.target - CNAME target (Railway public domain)
 * @param {boolean} [opts.proxied=true] - Whether to proxy through Cloudflare
 * @returns {Promise<{recordId: string, name: string, content: string}>}
 */
export async function createCloudflareCname(opts) {
  if (!opts.cloudflareToken) throw new Error('cloudflareToken is required');
  if (!opts.zoneId) throw new Error('zoneId is required');
  if (!opts.subdomain) throw new Error('subdomain is required');
  if (!opts.target) throw new Error('target is required');

  var result = await cloudflareRequest(opts.cloudflareToken, 'POST',
    '/zones/' + opts.zoneId + '/dns_records',
    {
      type: 'CNAME',
      name: opts.subdomain,
      content: opts.target,
      proxied: opts.proxied !== false,
      ttl: 1 // auto
    }
  );

  return {
    recordId: result.id,
    name: result.name,
    content: result.content
  };
}

/**
 * Poll a Mycelium instance's /health endpoint until it reports OK or timeout.
 *
 * @param {object} opts
 * @param {string} opts.url - Full URL to poll (e.g. "https://acme.mycelium.fyi/health")
 * @param {number} [opts.intervalMs=5000] - Polling interval in ms
 * @param {number} [opts.timeoutMs=120000] - Max wait time before giving up
 * @param {function} [opts.onPoll] - Optional callback on each poll attempt: (attempt, elapsed) => void
 * @returns {Promise<{ok: boolean, attempts: number, elapsed: number, response?: object}>}
 */
export async function pollHealth(opts) {
  if (!opts.url) throw new Error('url is required');

  var interval = opts.intervalMs || 5000;
  var timeout = opts.timeoutMs || 120000;
  var start = Date.now();
  var attempts = 0;

  while (true) {
    attempts++;
    var elapsed = Date.now() - start;

    if (opts.onPoll) opts.onPoll(attempts, elapsed);

    try {
      var res = await fetch(opts.url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        var body = await res.json();
        if (body.status === 'ok') {
          return { ok: true, attempts: attempts, elapsed: elapsed, response: body };
        }
      }
    } catch (e) {
      // Expected during startup — service not ready yet
    }

    if (elapsed + interval >= timeout) {
      return { ok: false, attempts: attempts, elapsed: elapsed };
    }

    await new Promise(function (resolve) { setTimeout(resolve, interval); });
  }
}

/**
 * Create an initial studio user on a remote Mycelium instance.
 * Calls the instance's own API to create the first admin user.
 *
 * @param {object} opts
 * @param {string} opts.instanceUrl - Base URL of the instance (e.g. "https://acme.mycelium.fyi")
 * @param {string} opts.adminKey - The instance's ADMIN_KEY
 * @param {string} opts.username - Username for the new studio user
 * @param {string} opts.password - Password for the new studio user
 * @param {string} [opts.displayName] - Display name (defaults to username)
 * @returns {Promise<{userId: number, username: string, token: string}>}
 */
export async function createRemoteStudioUser(opts) {
  if (!opts.instanceUrl) throw new Error('instanceUrl is required');
  if (!opts.adminKey) throw new Error('adminKey is required');
  if (!opts.username) throw new Error('username is required');
  if (!opts.password) throw new Error('password is required');

  var url = opts.instanceUrl.replace(/\/+$/, '') + '/api/mycelium/studio/users';
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': opts.adminKey
    },
    body: JSON.stringify({
      username: opts.username,
      password: opts.password,
      display_name: opts.displayName || opts.username,
      role: 'admin'
    })
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error('Failed to create studio user (' + res.status + '): ' + text);
  }

  var data = await res.json();
  return {
    userId: data.id || data.userId,
    username: opts.username,
    token: data.token || null
  };
}

/**
 * Add a custom domain to a Railway service so it serves traffic on that domain.
 *
 * @param {object} opts
 * @param {string} opts.railwayToken - Railway API token
 * @param {string} opts.serviceId - Railway service ID
 * @param {string} opts.environmentId - Railway environment ID
 * @param {string} opts.domain - Custom domain (e.g. "acme.mycelium.fyi")
 * @returns {Promise<{domainId: string, domain: string}>}
 */
export async function addRailwayCustomDomain(opts) {
  if (!opts.railwayToken) throw new Error('railwayToken is required');
  if (!opts.serviceId) throw new Error('serviceId is required');
  if (!opts.environmentId) throw new Error('environmentId is required');
  if (!opts.domain) throw new Error('domain is required');

  var data = await railwayQuery(opts.railwayToken, `
    mutation($serviceId: String!, $environmentId: String!, $domain: String!) {
      customDomainCreate(input: {
        serviceId: $serviceId,
        environmentId: $environmentId,
        domain: $domain
      }) {
        id
        domain
        status { dnsRecords { hostlabel type value } }
      }
    }
  `, {
    serviceId: opts.serviceId,
    environmentId: opts.environmentId,
    domain: opts.domain
  });

  var result = data.customDomainCreate;
  return {
    domainId: result.id,
    domain: result.domain,
    dnsRecords: result.status ? result.status.dnsRecords : []
  };
}

/**
 * Full provisioning pipeline: create instance, configure DNS, wait for health, create admin user.
 *
 * @param {object} config
 * @param {string} config.customerName - Slug for the customer (used as subdomain and service name)
 * @param {string} config.railwayToken - Railway API token
 * @param {string} [config.railwayProjectId] - Existing project ID (creates new if omitted)
 * @param {string} config.repoUrl - GitHub repo to deploy
 * @param {string} config.cloudflareToken - Cloudflare API token
 * @param {string} config.cloudflareZoneId - Cloudflare zone ID
 * @param {string} config.baseDomain - Base domain (e.g. "mycelium.fyi")
 * @param {string} config.adminKey - ADMIN_KEY to set on the new instance
 * @param {string} config.jwtSecret - JWT_SECRET to set on the new instance
 * @param {string} config.adminUsername - First admin user's username
 * @param {string} config.adminPassword - First admin user's password
 * @param {function} [config.onProgress] - Progress callback: (step, detail) => void
 * @returns {Promise<object>} Full provisioning result
 */
export async function provisionCustomerInstance(config) {
  var progress = config.onProgress || function () {};
  var customerDomain = config.customerName + '.' + config.baseDomain;

  // Step 1: Create Railway instance
  progress('railway', 'Creating Railway service...');
  var railway = await createRailwayInstance({
    railwayToken: config.railwayToken,
    projectId: config.railwayProjectId,
    repoUrl: config.repoUrl,
    serviceName: config.customerName,
    envVars: {
      JWT_SECRET: config.jwtSecret,
      ADMIN_KEY: config.adminKey,
      NODE_ENV: 'production',
      DATA_DIR: '/data'
    }
  });

  // Step 2: Add custom domain to Railway
  progress('domain', 'Adding custom domain to Railway...');
  var customDomain = await addRailwayCustomDomain({
    railwayToken: config.railwayToken,
    serviceId: railway.serviceId,
    environmentId: railway.environmentId,
    domain: customerDomain
  });

  // Step 3: Create Cloudflare CNAME
  progress('dns', 'Creating Cloudflare CNAME record...');
  var dns = await createCloudflareCname({
    cloudflareToken: config.cloudflareToken,
    zoneId: config.cloudflareZoneId,
    subdomain: config.customerName,
    target: customerDomain
  });

  // Step 4: Wait for instance to come online
  progress('health', 'Waiting for instance to come online...');
  var health = await pollHealth({
    url: 'https://' + customerDomain + '/health',
    intervalMs: 5000,
    timeoutMs: 180000,
    onPoll: function (attempt, elapsed) {
      progress('health', 'Polling... attempt ' + attempt + ' (' + Math.round(elapsed / 1000) + 's)');
    }
  });

  var result = {
    customerName: config.customerName,
    domain: customerDomain,
    url: 'https://' + customerDomain,
    railway: railway,
    customDomain: customDomain,
    dns: dns,
    health: health,
    studioUser: null
  };

  // Step 5: Create admin user (only if instance is healthy)
  if (health.ok) {
    progress('user', 'Creating admin studio user...');
    try {
      result.studioUser = await createRemoteStudioUser({
        instanceUrl: 'https://' + customerDomain,
        adminKey: config.adminKey,
        username: config.adminUsername,
        password: config.adminPassword
      });
    } catch (e) {
      result.studioUserError = e.message;
    }
  }

  progress('done', health.ok ? 'Instance provisioned successfully' : 'Instance deployed but health check timed out');
  return result;
}
