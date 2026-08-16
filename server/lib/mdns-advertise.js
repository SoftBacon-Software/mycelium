// Advertise the platform on the LAN as `_mycelium._tcp` (Bonjour/mDNS) so a
// from-scratch agent can DISCOVER this instance and join it — no explicit URL,
// no remembered binding, no deploy. This is the publish half of deploy-or-join
// (plugins/memory/mycelium/bootstrap.py:_mdns_browse browses exactly this
// service). Without it, DISCOVER is a dead branch and an agent can only ever
// find a platform it was TOLD about.
//
// Convention: the instance advertises under its HOSTNAME (e.g. "jetson01"). The
// agent reads the instance name out of the browse reply, appends ".local", and
// probes :3002/health — so name-free LAN binding works precisely when
// os.hostname() is resolvable as <name>.local. That is true on jetson01 (see
// reference_substrate_address_use_the_name: jetson01.local -> 192.168.50.106).
// Pinning the advertiser to an IP would defeat the whole point of discovery.
//
// PRIMARY = a system-registrar child process:
//   • Linux: `avahi-publish -s <name> _mycelium._tcp <port>` — registers through
//     the system avahi-daemon, the very responder browsers query, so macOS
//     dns-sd is guaranteed to see it (no userspace-multicast interop gamble).
//   • macOS: `dns-sd -R <name> _mycelium._tcp . <port>` — through mDNSResponder.
//   Both stay alive holding the registration and withdraw on SIGTERM.
// FALLBACK = bonjour-service (pure-JS, in-process multicast) for a host with
// neither registrar (e.g. a stripped Docker image).
//
// Fail-soft by design. Discovery is a LAN aid, not a daemon requirement: if
// every path is unavailable or multicast errors, advertising is SKIPPED with a
// loud log line and the API keeps serving. (A missing advertiser is the state
// this module exists to fix — but a crashed daemon advertises nothing either.)

import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

// Synchronous `command -v` (POSIX sh). Returns the resolved binary path, or null.
// Avoids the async ENOENT race you get from spawn()+on('error'): we know BEFORE
// we spawn whether the registrar exists, so a missing one falls through cleanly.
function whichSync(cmd) {
  if (process.platform === 'win32') return null;
  var r = spawnSync('sh', ['-c', 'command -v ' + JSON.stringify(cmd)], { encoding: 'utf8', timeout: 2000 });
  if (r.status === 0 && r.stdout) {
    var resolved = r.stdout.trim();
    if (resolved) return resolved;
  }
  return null;
}

function resolveName(opts) {
  var hostname = os.hostname() || '';
  return (opts.name && String(opts.name).trim()) ||
         (process.env.MYCELIUM_MDNS_NAME && process.env.MYCELIUM_MDNS_NAME.trim()) ||
         hostname.split('.')[0] ||
         'mycelium';
}

// Publish `_mycelium._tcp` for the listening port. Returns { stop } on success
// (call stop() on shutdown), or null when advertising is unavailable/skipped.
// Never throws: a discovery aid must not take the API down with it.
export async function startMdnsAdvertising(port, opts) {
  opts = opts || {};

  // Opt-out for cloud/NAT deploys where LAN multicast is meaningless or unwanted.
  if (process.env.MYCELIUM_NO_MDNS) {
    console.log('[mdns] MYCELIUM_NO_MDNS set — not advertising _mycelium._tcp');
    return null;
  }

  var name = resolveName(opts);
  var version = opts.version ? String(opts.version) : '';
  var txtPair = version ? ['v=' + version] : [];

  // 1) System registrar (preferred): avahi-publish on Linux, dns-sd -R on macOS.
  var registrar = pickRegistrar(name, port, txtPair);
  if (registrar) {
    var adv = spawnRegistrar(registrar, name, port);
    if (adv) return adv;
    // spawn failed (e.g. avahi-daemon down, binary vanished) — try the fallback.
  }

  // 2) In-process fallback: bonjour-service (pure-JS multicast).
  return await startBonjour(name, port, version);
}

function pickRegistrar(name, port, txtPair) {
  // Linux: avahi-publish through the system avahi-daemon (guaranteed interop).
  var avahi = whichSync('avahi-publish');
  if (avahi) {
    return { cmd: avahi, label: 'avahi-publish',
      args: ['-s', name, '_mycelium._tcp', String(port)].concat(txtPair) };
  }
  // macOS: dns-sd -R through mDNSResponder.
  if (process.platform === 'darwin') {
    var dnssd = whichSync('dns-sd');
    if (dnssd) {
      return { cmd: dnssd, label: 'dns-sd',
        args: ['-R', name, '_mycelium._tcp', '.', String(port)].concat(txtPair) };
    }
  }
  return null;
}

function spawnRegistrar(reg, name, port) {
  var child;
  try {
    child = spawn(reg.cmd, reg.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.warn('[mdns] could not spawn ' + reg.label + ' (' + (e && e.message) + ')');
    return null;
  }
  var alive = true;
  // Drain the pipes so a chatty registrar (dns-sd prints continuously) can't
  // fill its buffer and block. Surface nothing to the daemon's own stdout.
  if (child.stdout) child.stdout.on('data', function () {});
  if (child.stderr) child.stderr.on('data', function () {});
  child.on('error', function (err) {
    alive = false;
    console.warn('[mdns] ' + reg.label + ' error: ' + (err && err.message ? err.message : err));
  });
  child.on('exit', function (code, sig) {
    alive = false;
    // An early exit (avahi-daemon not running, bad args) means no registration.
    // Don't crash — the fallback or a logged skip handles it.
    console.warn('[mdns] ' + reg.label + ' exited (code=' + code + ' sig=' + sig +
      ') — _mycelium._tcp registration withdrawn or never established.');
  });
  console.log('[mdns] advertising _mycelium._tcp as "' + name + '" on port ' +
    port + ' (via ' + reg.label + ')');
  function stop() {
    if (!alive) return;
    alive = false;
    try { child.kill('SIGTERM'); } catch (e) { /* best-effort */ }
  }
  return { stop: stop };
}

// In-process fallback using bonjour-service (pure-JS multicast DNS). Loaded
// dynamically so an install without the dep degrades to "no advertising"
// instead of a boot crash. Multicast send errors (EHOSTUNREACH on a multihomed
// box, no route on NAT) are caught and degrade loudly — never crash the daemon.
async function startBonjour(name, port, version) {
  var Bonjour;
  try {
    var mod = await import('bonjour-service');
    Bonjour = mod.default || mod.Bonjour;
  } catch (e) {
    console.warn('[mdns] no system registrar and bonjour-service not installed — ' +
      'not advertising _mycelium._tcp (' + (e && e.message) + ').');
    return null;
  }
  if (typeof Bonjour !== 'function') {
    console.warn('[mdns] bonjour-service export shape unexpected — not advertising _mycelium._tcp.');
    return null;
  }

  var bonjour = null;
  var service = null;
  var failed = false;
  function describeErr(err) { return (err && err.code) || (err && err.message) || String(err); }
  function failAdvertise(reason) {
    if (failed) return;
    failed = true;
    console.warn('[mdns] advertising UNAVAILABLE — ' + reason + '. The API still ' +
      'serves; LAN discovery (_mycelium._tcp) is off until this host can multicast.');
    try { if (bonjour) bonjour.destroy(); } catch (_) { /* best-effort */ }
  }

  try {
    // Non-throwing errorCallback (2nd arg): bonjour-service's default THROWS on
    // send errors; the multicast-dns 'error' event covers socket/bind errors.
    bonjour = new Bonjour({}, function (err) {
      failAdvertise('mDNS send failed (' + describeErr(err) + ')');
    });
    var mdnsSocket = bonjour.server && bonjour.server.mdns;
    if (mdnsSocket && typeof mdnsSocket.on === 'function') {
      mdnsSocket.on('error', function (err) {
        failAdvertise('mDNS socket error (' + describeErr(err) + ')');
      });
    }
    if (failed) return null;
    var txt = version ? { v: version } : {};
    service = bonjour.publish({ name: name, type: 'mycelium', port: port, txt: txt });
  } catch (e) {
    failAdvertise('could not start (' + describeErr(e) + ')');
    return null;
  }
  if (failed) return null;

  console.log('[mdns] advertising _mycelium._tcp as "' + name + '" on port ' +
    port + ' (via bonjour-service)');
  var stopped = false;
  function stop() {
    if (stopped || failed) return;
    stopped = true;
    try { if (service) service.stop(); } catch (e) { /* best-effort */ }
    try { if (bonjour) bonjour.destroy(); } catch (e) { /* closes the multicast socket */ }
    console.log('[mdns] stopped advertising _mycelium._tcp');
  }
  return { stop: stop };
}
