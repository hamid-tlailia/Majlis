/* ============================================================
   المجلس — طبقة الشبكة | Majlis network client
   غرف فورية + مزامنة الحالة + صوت WebRTC + جودة الاتصال
   ============================================================ */
(function (global) {
  'use strict';

  const Net = {
    url: null, ws: null, you: null, room: null, game: null,
    connected: false, joining: false, closedByUser: false,
    seq: 0, rtt: null, quality: 'good', tries: 0,
    on: {},                    // خطّافات: room, state, input, sys, emote, quality, voice
    _pingTimer: null, _reTimer: null, _lastPong: 0,

    /* ---------- أدوات ---------- */
    emit(evt, data) { const f = this.on[evt]; if (f) { try { f(data); } catch (e) { console.error(e); } } },
    isHost() { return !!(this.room && this.you && this.room.hostId === this.you); },
    me() { return this.room?.players.find(p => p.id === this.you) || null; },
    others() { return (this.room?.players || []).filter(p => p.id !== this.you); },
    send(obj) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; } return false; },

    /* ---------- الاتصال ---------- */
    connect(url) {
      this.url = url || this.url;
      if (!this.url) return Promise.reject(new Error('no url'));
      this.closedByUser = false;
      return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(this.url); } catch (e) { return reject(e); }
        this.ws = ws;
        const timeout = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 9000);

        ws.onopen = () => {
          clearTimeout(timeout);
          this.connected = true; this.tries = 0; this._lastPong = Date.now();
          this._startPing();
          this.emit('quality', { quality: 'good', rtt: null });
          resolve();
        };
        ws.onmessage = ev => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          this._handle(m);
        };
        ws.onerror = () => { clearTimeout(timeout); };
        ws.onclose = () => {
          clearTimeout(timeout);
          if (this.ws !== ws) return;        // قناة قديمة — تجاهلها
          this.connected = false;
          this._stopPing();
          this._setQuality('offline');
          Voice.stopAll();
          if (!this.closedByUser) this._retry();
        };
      });
    },

    _retry() {
      if (this._reTimer) return;
      const wait = Math.min(1000 * Math.pow(1.7, this.tries++), 15000);
      this.emit('sys', { code: 'reconnecting', wait });
      this._reTimer = setTimeout(async () => {
        this._reTimer = null;
        try {
          const code = this.room?.code || this._openCode;
          if (code && this._openCode) await this.openFor(code); else await this.connect();
          if (code) this.emit('sys', { code: 'rejoin_ask', room: code });
        } catch { this._retry(); }
      }, wait);
    },

    disconnect() {
      this.closedByUser = true;
      this.send({ t: 'leave' });
      this._stopPing(); Voice.stopAll();
      try { this.ws && this.ws.close(); } catch {}
      this.ws = null; this.room = null; this.you = null; this.connected = false;
      this._setQuality('offline');
    },

    /* ---------- الغرف ---------- */
    /* بعض الخوادم (Cloudflare) توجّه كل غرفة إلى كائن مستقل عبر ?code= */
    _base() { return (this.url || '').replace(/\/(ws)?$/, ''); },
    _wsUrl(code) {
      const b = this._base();
      const path = /\/ws$/.test(this.url || '') ? this.url : (b + '/ws');
      return code ? `${path}?code=${encodeURIComponent(code)}` : (this.url || path);
    },
    async _newCode() {
      try {
        const http = this._base().replace(/^ws/, 'http');
        const r = await fetch(http + '/new', { cache: 'no-store' });
        if (!r.ok) return null;
        const j = await r.json();
        return j.code || null;
      } catch { return null; }
    },
    async openFor(code) {
      /* أعِد الاتصال إن كانت القناة الحالية لغرفة أخرى */
      if (this.connected && this._openCode === (code || null)) return true;
      if (this.ws) {                       // افصل القناة القديمة بلا آثار جانبية
        const old = this.ws;
        old.onclose = old.onmessage = old.onerror = old.onopen = null;
        try { old.close(); } catch {}
        this.ws = null; this.connected = false;
      }
      const target = code ? this._wsUrl(code) : this.url;
      const keep = this.url;
      await this.connect(target);
      this.url = keep;              // نحتفظ بالعنوان الأصلي للإعدادات
      this._openCode = code || null;
      return true;
    },
    async _plain() { if (!this.connected) await this.connect(this.url); return true; },
    /* ننتظر فعلياً وصول رد 'joined' من الخادم، لا فقط إرسال الطلب */
    _waitJoined(timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const done = ok => { clearTimeout(timer); this._joinWait = null; ok ? resolve(this.room) : reject(new Error('join failed')); };
        const timer = setTimeout(() => done(false), timeoutMs);
        this._joinWait = done;
      });
    },
    async create(name, game) {
      Net.myName = name;
      const code = await this._newCode();          // Cloudflare يعطينا رمزاً مسبقاً
      if (code) await this.openFor(code); else await this._plain();
      const wait = this._waitJoined();
      this.send({ t: 'create', name, game, code });
      return wait;
    },
    rejoin(code) {
      return this.send({ t: 'join', code, name: Net.myName, rejoin: this.you });
    },
    async join(code, name) {
      Net.myName = name;
      const c = String(code || '').toUpperCase().trim();
      const pre = await this._newCode();           // هل الخادم يوجّه كل غرفة إلى مسار خاص؟
      if (pre !== null) await this.openFor(c); else await this._plain();
      const wait = this._waitJoined();
      this.send({ t: 'join', code: c, name });
      return wait;
    },
    setGame(game) { return this.send({ t: 'game', game }); },

    /* المضيف يبثّ لقطة، والضيف يرسل نيّة */
    pushState(game, state) { if (this.isHost()) this.send({ t: 'state', game, state }); },
    input(action, args) { this.send({ t: 'input', action, args }); },
    emote(e) { this.send({ t: 'emote', e }); },

    /* ---------- جودة الاتصال ---------- */
    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        const ts = Date.now();
        this._pendingTs = ts;
        this.send({ t: 'ping', ts, rtt: this.rtt ?? undefined });
        /* لم يصل ردّ منذ فترة طويلة → الاتصال متعثّر */
        if (Date.now() - this._lastPong > 9000) this._setQuality('weak');
      }, 3000);
    },
    _stopPing() { clearInterval(this._pingTimer); this._pingTimer = null; },
    _setQuality(q) {
      if (this.quality === q) return;
      this.quality = q;
      this.emit('quality', { quality: q, rtt: this.rtt });
    },

    /* ---------- الرسائل الواردة ---------- */
    _handle(m) {
      switch (m.t) {
        case 'joined':
          this.you = m.you; this.room = m.room; this.game = m.room.game;
          this.seq = m.seq || 0;
          this.emit('room', this.room);
          if (m.state) this.emit('state', { state: m.state, seq: m.seq, game: m.room.game });
          if (this._joinWait) this._joinWait(true);
          break;
        case 'room':
          this.room = m.room; this.emit('room', m.room); Voice.reconcile(); break;
        case 'state':
          if (m.seq && m.seq <= this.seq) break;         // تجاهل اللقطات القديمة
          this.seq = m.seq || this.seq + 1;
          this.emit('state', { state: m.state, seq: this.seq, game: m.game });
          break;
        case 'input':  this.emit('input', m); break;
        case 'game':   this.game = m.game; this.emit('game', m.game); break;
        case 'emote':  this.emit('emote', m); break;
        case 'sys':    this.emit('sys', m); break;
        case 'err':
          this.emit('sys', { code: 'err_' + m.code });
          if (this._joinWait) this._joinWait(false);
          break;
        case 'voice':  Voice.onPeerVoice(m.id, m.on); this.emit('voice', m); break;
        case 'signal': Voice.onSignal(m.from, m.data); break;
        case 'pong': {
          this._lastPong = Date.now();
          const rtt = Date.now() - m.ts;
          this.rtt = this.rtt === null ? rtt : Math.round(this.rtt * 0.6 + rtt * 0.4);
          this._setQuality(this.rtt < 150 ? 'good' : this.rtt < 400 ? 'ok' : 'weak');
          break;
        }
      }
    }
  };

  /* ============================================================
     الصوت — WebRTC نظير لنظير بجودة عالية
     ============================================================ */
  const Voice = {
    on: false, stream: null, peers: new Map(), ice: null, muted: false, _tick: null,

    async iceConfig() {
      if (this.ice) return this.ice;
      try {
        const base = (Net.url || '').replace(/\/(ws)?$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        const r = await fetch(base + '/ice', { cache: 'no-store' });
        this.ice = await r.json();
      } catch {
        this.ice = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }] };
      }
      if (!this.ice.iceServers) this.ice = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
      return this.ice;
    },

    async start() {
      if (this.on) return true;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            channelCount: 1, sampleRate: 48000
          }, video: false
        });
      } catch (e) { Net.emit('sys', { code: 'mic_denied' }); return false; }
      this.on = true;
      await this.iceConfig();
      Net.send({ t: 'voice', on: true });
      this.reconcile();
      /* مصالحة دورية: تعالج فوارق التوقيت وفشل أول محاولة */
      clearInterval(this._tick);
      this._tick = setInterval(() => this.reconcile(), 3000);
      return true;
    },

    stop() {
      Net.send({ t: 'voice', on: false });
      clearInterval(this._tick); this._tick = null;
      this.stopAll();
    },

    stopAll() {
      for (const [id, pc] of this.peers) { try { pc.close(); } catch {} this._removeAudio(id); }
      this.peers.clear();
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      this.on = false;
      clearInterval(this._tick); this._tick = null;
    },

    setMuted(v) {
      this.muted = v;
      if (this.stream) this.stream.getAudioTracks().forEach(t => (t.enabled = !v));
    },

    /* تأكّد من وجود اتصال مع كل من فتح صوته — البادئ هو صاحب المعرّف الأصغر */
    reconcile() {
      if (!this.on || !Net.room) return;
      const live = new Set();
      for (const p of Net.others()) {
        if (!p.online || !p.voice) continue;
        live.add(p.id);
        const pc = this.peers.get(p.id);
        const dead = pc && ['failed', 'closed', 'disconnected'].includes(pc.connectionState);
        if (dead) { try { pc.close(); } catch {} this.peers.delete(p.id); this._removeAudio(p.id); }
        if (!this.peers.has(p.id) && Net.you < p.id) this.call(p.id);
      }
      for (const [id, pc] of [...this.peers]) {
        if (!live.has(id)) { try { pc.close(); } catch {} this.peers.delete(id); this._removeAudio(id); }
      }
    },

    async pc(id) {
      if (this.peers.has(id)) return this.peers.get(id);
      const cfg = await this.iceConfig();
      const pc = new RTCPeerConnection(cfg);
      this.peers.set(id, pc);
      pc._pending = [];
      /* أرسل صوتي إن كان الميكروفون مفتوحاً */
      if (this.stream) this.stream.getTracks().forEach(t => pc.addTrack(t, this.stream));
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.onicecandidate = e => { if (e.candidate) Net.send({ t: 'signal', to: id, data: { candidate: e.candidate } }); };
      pc.ontrack = e => this._attachAudio(id, e.streams[0]);
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(pc.connectionState)) { this._removeAudio(id); this.peers.delete(id); }
      };
      return pc;
    },

    async call(id) {
      const pc = await this.pc(id);
      if (pc._making || pc.signalingState !== 'stable') return;
      pc._making = true;
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        offer.sdp = this._tuneSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        Net.send({ t: 'signal', to: id, data: { sdp: pc.localDescription } });
      } catch (e) { console.warn('voice offer', e); }
      pc._making = false;
    },

    async onSignal(from, data) {
      const pc = await this.pc(from);
      try {
        if (data.sdp) {
          const polite = Net.you > from;               // الأدب: الأكبر معرّفاً يتنازل
          const offerCollision = data.sdp.type === 'offer' &&
            (pc._making || pc.signalingState !== 'stable');
          if (offerCollision && !polite) return;
          if (offerCollision) await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          for (const c of pc._pending.splice(0)) { try { await pc.addIceCandidate(c); } catch {} }
          if (data.sdp.type === 'offer') {
            const ans = await pc.createAnswer();
            ans.sdp = this._tuneSdp(ans.sdp);
            await pc.setLocalDescription(ans);
            Net.send({ t: 'signal', to: from, data: { sdp: pc.localDescription } });
          }
        } else if (data.candidate) {
          const c = new RTCIceCandidate(data.candidate);
          if (pc.remoteDescription && pc.remoteDescription.type) { try { await pc.addIceCandidate(c); } catch {} }
          else pc._pending.push(c);
        }
      } catch (e) { console.warn('voice signal', e); }
    },

    onPeerVoice(id, on) { this.reconcile(); },

    _tuneSdp(sdp) {
      return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g,
        'a=fmtp:$1 $2;stereo=0;maxaveragebitrate=48000;maxplaybackrate=48000;cbr=0;usedtx=0');
    },

    _attachAudio(id, stream) {
      let a = document.getElementById('va_' + id);
      if (!a) {
        a = document.createElement('audio');
        a.id = 'va_' + id; a.autoplay = true; a.playsInline = true;
        a.setAttribute('playsinline', ''); a.style.display = 'none';
        document.body.appendChild(a);
      }
      a.srcObject = stream;
      const go = () => a.play().catch(() => {});
      go();
      document.addEventListener('click', go, { once: true });   // بعض المتصفحات تحتاج لمسة
    },
    _removeAudio(id) { document.getElementById('va_' + id)?.remove(); }
  };


  /* ============================================================
     الردهة — حضور عام ودعوات مباشرة (قناة مستقلة)
     ============================================================ */
  const Lobby = {
    ws: null, you: null, players: [], on: {}, name: '', _t: null,
    emit(e, d) { const f = this.on[e]; if (f) { try { f(d); } catch (x) { console.error(x); } } },
    connected() { return !!(this.ws && this.ws.readyState === 1); },
    send(o) { if (this.connected()) { this.ws.send(JSON.stringify(o)); return true; } return false; },

    join(name) {
      this.name = name || this.name;
      if (this.connected()) { this.send({ t: 'status', s: 'free' }); return; }
      const base = Net._base ? Net._base() : (Net.url || '');
      const path = /\/ws$/.test(Net.url || '') ? Net.url : (base + '/ws');
      let ws;
      try { ws = new WebSocket(path + '?code=LOBBY'); } catch { return; }
      this.ws = ws;
      ws.onopen = () => {
        this.send({ t: 'join', code: 'LOBBY', name: this.name });
        clearInterval(this._t);
        this._t = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), 25000);
      };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'joined') { this.you = m.you; this.players = m.room.players; this.emit('list', this.players); }
        else if (m.t === 'room') { this.players = m.room.players; this.emit('list', this.players); }
        else if (m.t === 'invite') this.emit('invite', m);
        else if (m.t === 'inviteReply') this.emit('reply', m);
        else if (m.t === 'err') this.emit('err', m);
      };
      ws.onclose = () => { clearInterval(this._t); this.ws = null; this.you = null; this.players = []; this.emit('list', []); };
    },
    leave() { clearInterval(this._t); try { this.ws && this.ws.close(); } catch {} this.ws = null; },
    status(s) { this.send({ t: 'status', s }); },
    invite(to, code, game) { return this.send({ t: 'invite', to, code, game }); },
    reply(to, ok) { return this.send({ t: 'inviteReply', to, ok }); },
    others() { return this.players.filter(p => p.id !== this.you && p.online); }
  };
  Net.Lobby = Lobby;
  Net.Voice = Voice;
  global.MajlisNet = Net;
})(window);
