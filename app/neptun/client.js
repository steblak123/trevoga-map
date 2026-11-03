// Live feed of the open NEPTUN API (https://neptun.in.ua/developers): a WebSocket stream
// (snapshot → upsert / remove → heartbeat) with automatic reconnect and a REST fallback.
// No key is needed. API terms: REST no more often than every 5 s, attribution required.
(function (root) {
  const WS_URL = 'wss://neptun.in.ua/api/v1/stream';
  const REST_URL = 'https://neptun.in.ua/api/v1/threats';
  const REST_GAP = 15000; // min interval between REST requests while the stream is down
  const WATCHDOG = 50000; // heartbeats arrive every ~15 s; silence this long means a dead socket
  const MAX_BACKOFF = 30000;

  function validThreat(t) {
    return (
      t && typeof t === 'object' && typeof t.id === 'string' && typeof t.type === 'string' &&
      Number.isFinite(t.lat) && Number.isFinite(t.lon) &&
      Math.abs(t.lat) <= 90 && Math.abs(t.lon) <= 180 && t.status !== 'resolved'
    );
  }

  class NeptunClient {
    constructor() {
      this.threats = new Map(); // id -> threat
      this.status = 'off'; // off | connecting | live | reconnecting
      this.updatedAt = null; // server time of the last frame (ms)
      this.listeners = new Set();
      this.ws = null;
      this.retries = 0;
      this.timer = null;
      this.watchdog = null;
      this.lastRest = 0;
      this.stopped = true;
      if (typeof addEventListener === 'function') addEventListener('online', () => this.retryNow());
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    emit(kind) {
      for (const fn of this.listeners) {
        try {
          fn(kind, this);
        } catch (e) {
          console.error('[neptun] listener', e);
        }
      }
    }

    list() {
      return [...this.threats.values()];
    }

    start() {
      if (!this.stopped) return;
      this.stopped = false;
      this.retries = 0;
      this.connect();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
      clearTimeout(this.watchdog);
      this.closeSocket();
      this.threats.clear();
      this.setStatus('off');
      this.emit('data');
    }

    retryNow() {
      if (this.stopped || (this.ws && this.status === 'live')) return;
      clearTimeout(this.timer);
      this.retries = 0;
      this.connect();
    }

    setStatus(s) {
      if (s === this.status) return;
      this.status = s;
      this.emit('status');
    }

    closeSocket() {
      const ws = this.ws;
      this.ws = null;
      if (!ws) return;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }

    connect() {
      if (this.stopped) return;
      this.closeSocket();
      this.setStatus(this.retries ? 'reconnecting' : 'connecting');
      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (e) {
        return this.scheduleReconnect();
      }
      this.ws = ws;
      ws.onopen = () => {
        this.retries = 0;
        this.kick();
      };
      ws.onmessage = (e) => {
        this.kick();
        this.handle(String(e.data));
      };
      ws.onclose = () => {
        if (this.ws === ws) this.scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    }

    // Any frame resets the watchdog; a silent socket is closed and reopened.
    kick() {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        console.log('[neptun] stream silent, reconnecting');
        this.scheduleReconnect();
      }, WATCHDOG);
    }

    scheduleReconnect() {
      clearTimeout(this.watchdog);
      this.closeSocket();
      if (this.stopped) return;
      this.retries++;
      this.setStatus('reconnecting');
      this.restFallback();
      const delay = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(this.retries - 1, 5)) + Math.floor(Math.random() * 500);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), delay);
    }

    async restFallback() {
      if (Date.now() - this.lastRest < REST_GAP) return;
      this.lastRest = Date.now();
      try {
        const res = await fetch(REST_URL, { cache: 'no-store' });
        if (!res.ok || this.stopped || this.status === 'live') return;
        const body = await res.json();
        this.threats = new Map((body.threats || []).filter(validThreat).map((t) => [t.id, t]));
        this.updatedAt = Date.parse(body.serverTime) || Date.now();
        this.emit('data');
      } catch (e) {
        console.log('[neptun] REST fallback failed:', e.message);
      }
    }

    handle(raw) {
      let env;
      try {
        env = JSON.parse(raw);
      } catch {
        return;
      }
      const ts = Date.parse(env.ts);
      if (ts) this.updatedAt = ts;
      switch (env.type) {
        case 'snapshot': {
          const list = (env.data && env.data.threats) || [];
          this.threats = new Map(list.filter(validThreat).map((t) => [t.id, t]));
          this.setStatus('live');
          this.emit('data');
          break;
        }
        case 'upsert':
          if (validThreat(env.data)) this.threats.set(env.data.id, env.data);
          else if (env.data && env.data.status === 'resolved') this.threats.delete(env.data.id);
          this.emit('data');
          break;
        case 'remove':
          if (env.data && this.threats.delete(env.data.id)) this.emit('data');
          break;
        case 'heartbeat':
          this.setStatus('live');
          this.emit('tick');
          break;
        default: // 'alerts' and future frame types are not used here
          break;
      }
    }
  }

  root.NeptunClient = NeptunClient;
})(self);
