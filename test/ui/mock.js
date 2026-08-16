// Simulates the Google Apps Script backend (google.script.run) with realistic latency.
(function () {
  var LAT = 150; // ms simulated server latency
  var PIN = '1234';
  var db = { jobs: [] };
  var uid = 0;

  function requireAdmin(pin) {
    if (String(pin) !== PIN) throw new Error('Admin only — wrong PIN');
  }
  function svg(id) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect width="400" height="300" fill="#64748b"/>' +
      '<text x="200" y="150" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">' + id + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
  }

  window.__imgRequests = [];
  db.inv = [];
  var STOCK_SECTIONS = [
    { name: 'Fabric', hint: '10 combined rolls = FREE SHIPPING', items: [
      { name: 'Eyelet', target: 10 }, { name: 'Mini Eyelet', target: 10 },
      { name: 'Interlock', target: 5 }, { name: 'RJPK', target: 5 },
      { name: 'Hexagon', target: 5 }, { name: 'Ultron', target: 3 },
      { name: 'Mesh', target: 3 }, { name: 'Lycra 280', target: 3 }, { name: 'Cotton', target: 3 }
    ] },
    { name: 'Ink', hint: 'Ink supplier: FREE DELIVERY · order if below 2', orderIf: 2, items: [
      { name: 'Ink - Red', target: 3 }, { name: 'Ink - Blue', target: 3 },
      { name: 'Ink - Yellow', target: 3 }, { name: 'Ink - Black', target: 3 }
    ] },
    { name: 'Paper', hint: '', items: [
      { name: 'Paper - Sublimation', target: 5 }, { name: 'Paper - Protection', target: 3 }
    ] }
  ];
  var api = {
    submitStockTake: function (values, by) {
      if (!values || !values.length) throw new Error('Key in at least one stock value');
      var ts = Date.now(), saved = 0;
      values.forEach(function (v) {
        var q = v ? Number(v.qty) : NaN;
        if (!v || !v.item || isNaN(q) || q < 0) return;
        db.inv.push({ at: ts, item: v.item, qty: q, by: by === 'admin' ? 'admin' : 'staff' });
        saved++;
      });
      if (!saved) throw new Error('Key in at least one stock value');
      return { ok: true, at: ts, saved: saved };
    },
    getStockTake: function () {
      var latest = {}, lastAt = 0;
      db.inv.forEach(function (r) {
        latest[r.item] = { qty: r.qty, at: r.at, by: r.by };
        if (r.at > lastAt) lastAt = r.at;
      });
      return {
        sections: STOCK_SECTIONS.map(function (sec) {
          return { name: sec.name, hint: sec.hint || '', items: sec.items.map(function (it) {
            var l = latest[it.name];
            return { name: it.name, target: it.target, orderIf: sec.orderIf || it.target,
                     qty: l ? l.qty : '', at: l ? l.at : '', by: l ? l.by : '' };
          }) };
        }),
        lastAt: lastAt
      };
    },
    checkPin: function (pin) { return String(pin) === PIN; },
    getImagesData: function (ids) {
      var out = {};
      ids.slice(0, 8).forEach(function (id) {
        window.__imgRequests.push(id);
        out[id] = id.indexOf('missing') >= 0 ? null : svg(id);
      });
      return out;
    },
    addPhotoToJob: function (id, index, full, thumb) {
      if (!full) throw new Error('Photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      while (j.photoIds.length <= index) j.photoIds.push('');
      while (j.thumbIds.length <= index) j.thumbIds.push('');
      j.photoIds[index] = 'ph-' + id + '-' + index;
      j.thumbIds[index] = thumb ? ('th-' + id + '-' + index) : '';
      return { id: id, index: index, photoId: j.photoIds[index], thumbId: j.thumbIds[index] };
    },
    getJobs: function (tab) {
      return db.jobs
        .filter(function (j) { return j.tab === tab && j.status !== 'archived'; })
        .slice().reverse()
        .map(function (j) { return JSON.parse(JSON.stringify(j)); });
    },
    getCounts: function () {
      var c = { want: 0, delivery: 0, postage: 0, defect: 0 };
      db.jobs.forEach(function (j) { if (j.status === 'pending') c[j.tab]++; });
      return c;
    },
    addJob: function (p) {
      if (!p.photos || !p.photos.length) throw new Error('Photo required');
      if (p.clientId) {
        var dup = db.jobs.find(function (x) { return x.id === p.clientId; });
        if (dup) return JSON.parse(JSON.stringify(dup)); // idempotent retry
      }
      uid++;
      var job = {
        id: p.clientId || ('j' + uid), tab: p.tab, category: p.category || '', note: p.note || '',
        photoIds: p.photos.map(function (_, i) { return 'ph' + uid + '-' + i; }),
        thumbIds: p.photos.map(function (_, i) { return (p.thumbs && p.thumbs[i]) ? ('th' + uid + '-' + i) : ''; }),
        status: 'pending', createdAt: Date.now(), doneAt: '',
        proofPhotoId: '', proofThumbId: '',
        dueAt: p.dueAt || '', pinnedAt: '', jsCount: p.jsCount || 0,
        customer: (p.customer || '').trim() || 'Unassigned',
        folderId: 'fold-' + (uid),
        nextTab: (p.tab === 'want' && (p.nextTab === 'delivery' || p.nextTab === 'postage')) ? p.nextTab : '',
        nextCategory: p.nextCategory || '', nextDueAt: p.nextDueAt || '', nextJobId: '',
        problem: '', problemAt: '', printedAt: '', printPhotoId: '', printThumbId: '',
        deliveredAt: '', deliveredPhotoId: '', deliveredThumbId: '', problemNote: '', deliveredVia: '', deliveredBy: '', sentAt: ''
      };
      db.jobs.push(job);
      return JSON.parse(JSON.stringify(job));
    },
    getInitData: function (tab) {
      return { jobs: api.getJobs(tab), counts: api.getCounts() };
    },
    getAllData: function () {
      return {
        jobs: { want: api.getJobs('want'), delivery: api.getJobs('delivery'), postage: api.getJobs('postage'), defect: api.getJobs('defect') },
        counts: api.getCounts()
      };
    },
    editJob: function (id, ch, pin) {
      requireAdmin(pin);
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      ch.photos = (ch.photos || []).filter(function (p) { return p && (p.b64 || p.id); });
      if (!ch.photos.length) throw new Error('Photo required');
      j.note = ch.note || ''; j.category = ch.category || '';
      j.dueAt = ch.dueAt || '';
      j.jsCount = ch.jsCount || 0;
      if (ch.customer !== undefined) j.customer = (ch.customer || '').trim() || 'Unassigned';
      j.photoIds = ch.photos.map(function (p, i) { return p.b64 ? ('phnew-' + id + '-' + i) : p.id; });
      j.thumbIds = ch.photos.map(function (p, i) { return p.b64 ? ('thnew-' + id + '-' + i) : (p.thumbId || ''); });
      return JSON.parse(JSON.stringify(j));
    },
    searchHistory: function (q, pin, tab, category) {
      q = String(q || '').toLowerCase().trim();
      var all = db.jobs.slice().reverse().filter(function (j) {
        if (!j.proofPhotoId) return false; // evidence = has a proof photo
        if (tab && j.tab !== tab) return false;
        if (category && j.category !== category) return false;
        if (!q) return true;
        return (j.note + ' ' + (j.customer || '') + ' ' + j.category + ' ' + j.tab).toLowerCase().indexOf(q) >= 0;
      });
      all.sort(function (a, b) {
        var oa = (a.deliveredAt || a.sentAt) ? 1 : 0;
        var ob = (b.deliveredAt || b.sentAt) ? 1 : 0;
        if (oa !== ob) return ob - oa;
        var ka = Math.max(Number(a.sentAt || 0), Number(a.deliveredAt || 0), Number(a.doneAt || 0), Number(a.createdAt || 0));
        var kb = Math.max(Number(b.sentAt || 0), Number(b.deliveredAt || 0), Number(b.doneAt || 0), Number(b.createdAt || 0));
        return kb - ka;
      });
      return { results: JSON.parse(JSON.stringify(all.slice(0, 100))), total: all.length, driveFolderId: 'MASTERFOLD' };
    },
    getPerformance: function (pin) {
      requireAdmin(pin);
      var now = new Date();
      function ymd(ts) {
        var d = new Date(Number(ts));
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
      }
      var days = [], idx = {};
      for (var k = 13; k >= 0; k--) {
        var dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - k);
        idx[ymd(dt.getTime())] = days.length;
        days.push({ ymd: ymd(dt.getTime()), at: dt.getTime(), posted: 0, done: 0, out: 0, open: 0, checks: 0 });
      }
      db.jobs.forEach(function (j) {
        var createdAt = Number(j.createdAt || 0), doneAt = Number(j.doneAt || 0);
        var deliveredAt = Number(j.deliveredAt || 0), sentAt = Number(j.sentAt || 0);
        if (j.tab === 'want') {
          if (doneAt && idx[ymd(doneAt)] != null) days[idx[ymd(doneAt)]].checks++;
          return;
        }
        if (createdAt && idx[ymd(createdAt)] != null) {
          days[idx[ymd(createdAt)]].posted++;
          if (j.status === 'pending') days[idx[ymd(createdAt)]].open++;
        }
        if (doneAt && j.proofPhotoId && idx[ymd(doneAt)] != null) days[idx[ymd(doneAt)]].done++;
        if (deliveredAt && idx[ymd(deliveredAt)] != null) days[idx[ymd(deliveredAt)]].out++;
        if (sentAt && idx[ymd(sentAt)] != null) days[idx[ymd(sentAt)]].out++;
      });
      days.reverse();
      return { days: days };
    },
    undoSwipe: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.status !== 'got' && j.status !== 'notseen') throw new Error('Nothing to undo');
      j.status = 'pending'; j.doneAt = ''; j.pinnedAt = Date.now();
      var pulledBack = '';
      if (j.nextJobId) {
        var idx = db.jobs.findIndex(function (x) { return x.id === j.nextJobId && x.status === 'pending'; });
        if (idx >= 0) { db.jobs.splice(idx, 1); pulledBack = j.nextJobId; }
        j.nextJobId = '';
      }
      return { id: id, status: 'pending', pinnedAt: j.pinnedAt, pulledBack: pulledBack };
    },
    askAgain: function (id, pin) {
      requireAdmin(pin);
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.status = 'pending'; j.doneAt = ''; j.pinnedAt = Date.now();
      return { id: id, status: 'pending', pinnedAt: j.pinnedAt };
    },
    resetDone: function (pin) {
      requireAdmin(pin);
      var archived = 0, carried = 0, snap = {};
      db.jobs.forEach(function (j) {
        if (j.status === 'archived') return;
        var finished = (j.tab === 'want' && j.status === 'got') ||
          (j.status === 'done' && (j.tab === 'defect' ||
            (j.tab === 'delivery' && j.deliveredAt) ||
            (j.tab === 'postage' && j.sentAt)));
        if (finished) {
          snap[j.id] = j.status; j.status = 'archived'; archived++;
        } else carried++;
      });
      if (archived > 0) db.lastReset = snap;
      return { ok: true, archived: archived, carried: carried };
    },
    undoReset: function (pin) {
      requireAdmin(pin);
      if (!db.lastReset) throw new Error('Nothing to undo');
      var restored = 0;
      db.jobs.forEach(function (j) {
        if (db.lastReset[j.id] && j.status === 'archived') { j.status = db.lastReset[j.id]; restored++; }
      });
      db.lastReset = null;
      return { ok: true, restored: restored };
    },
    updateProof: function (id, proof, proofThumb) {
      if (!proof) throw new Error('Proof photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.proofPhotoId = 'reproof-' + id;
      j.proofThumbId = proofThumb ? ('reproofth-' + id) : '';
      return { id: id, proofPhotoId: j.proofPhotoId, proofThumbId: j.proofThumbId };
    },
    deleteProof: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.status = 'pending'; j.doneAt = ''; j.proofPhotoId = ''; j.proofThumbId = '';
      j.deliveredAt = ''; j.deliveredPhotoId = ''; j.deliveredThumbId = ''; j.deliveredVia = ''; j.deliveredBy = ''; j.sentAt = '';
      return { id: id, status: 'pending' };
    },
    resetAll: function (pin) {
      requireAdmin(pin);
      var n = 0, snap = {};
      db.jobs.forEach(function (j) {
        if (j.status !== 'archived') { snap[j.id] = j.status; j.status = 'archived'; n++; }
      });
      if (n > 0) db.lastReset = snap;
      return { ok: true, archived: n };
    },
    deleteJob: function (id, pin) {
      requireAdmin(pin);
      var i = db.jobs.findIndex(function (x) { return x.id === id; });
      if (i < 0) throw new Error('Job not found');
      db.jobs.splice(i, 1);
      return { ok: true, id: id };
    },
    reportProblem: function (id, kind) {
      var mark = kind === 'sticker' ? 'nosticker' : 'reported';
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.tab !== 'delivery' && j.tab !== 'postage' && j.tab !== 'defect') throw new Error('Only Delivery/Postage/Defect jobs can be reported');
      if (mark === 'nosticker' && j.tab !== 'postage') throw new Error('No-sticker reports are for Postage jobs');
      if (j.problem === mark) return { id: id, problem: mark, problemAt: j.problemAt };
      j.problem = mark; j.problemAt = Date.now(); j.printedAt = '';
      return { id: id, problem: mark, problemAt: j.problemAt };
    },
    solveProblem: function (id, photo, thumb) {
      if (!photo) throw new Error('Printing photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      var isProblem = j.problem === 'reported' || j.problem === 'nosticker' ||
        (j.tab === 'want' && j.status === 'notseen');
      if (!isProblem) throw new Error('This job is not on the Problem page');
      j.problem = 'printed'; j.printedAt = Date.now();
      j.printPhotoId = 'print-' + id;
      j.printThumbId = thumb ? ('printth-' + id) : '';
      return { id: id, problem: 'printed', printedAt: j.printedAt, printPhotoId: j.printPhotoId, printThumbId: j.printThumbId };
    },
    setProblemNote: function (id, text) {
      text = String(text || '').slice(0, 300);
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      var isProblem = j.problem === 'reported' || j.problem === 'nosticker' ||
        (j.tab === 'want' && j.status === 'notseen');
      if (!isProblem) throw new Error('This job is not on the Problem page');
      j.problemNote = text;
      return { id: id, problemNote: text };
    },
    markSentJnt: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.tab !== 'postage') throw new Error('Sent-to-J&T is for Postage jobs');
      if (j.status !== 'done') throw new Error('Finish the parcel first (Done + proof), then mark Sent');
      j.sentAt = Date.now();
      return { id: id, sentAt: j.sentAt };
    },
    undoSentJnt: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.sentAt = '';
      return { id: id, sentAt: '' };
    },
    markDelivered: function (id, via, by) {
      var VIAS = { lalamove: 1, bus: 1, pickup: 1, personal: 1 };
      if (!VIAS[via]) throw new Error('Choose HOW it was delivered');
      if (by !== 'ZH' && by !== 'Bob') throw new Error('Choose who delivered — Bos (ZH) or Bob');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.tab !== 'delivery') throw new Error('Delivered confirmation is for Delivery jobs');
      if (j.status !== 'done') throw new Error('Finish the job first (Done + proof), then confirm delivered');
      j.deliveredAt = Date.now(); j.deliveredVia = via; j.deliveredBy = by;
      return { id: id, deliveredAt: j.deliveredAt, deliveredVia: via, deliveredBy: by };
    },
    removeDelivered: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.deliveredAt = ''; j.deliveredPhotoId = ''; j.deliveredThumbId = ''; j.deliveredVia = ''; j.deliveredBy = '';
      return { id: id, deliveredAt: '' };
    },
    sentBus: function (id, proof, proofThumb) {
      if (!proof) throw new Error('Proof photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.tab !== 'postage') throw new Error('Only a postage job can be marked Sent bus');
      j.tab = 'delivery'; j.category = 'bus'; j.status = 'done'; j.doneAt = Date.now();
      j.proofPhotoId = 'proof-' + id;
      j.proofThumbId = proofThumb ? ('proofth-' + id) : '';
      return { id: id, tab: 'delivery', category: 'bus', status: 'done', doneAt: j.doneAt,
               proofPhotoId: j.proofPhotoId, proofThumbId: j.proofThumbId };
    },
    updateStatus: function (id, status, proof, proofThumb, pin) {
      if (status === 'archived') requireAdmin(pin);
      if (status === 'done' && !proof) throw new Error('Proof photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.status = status;
      if (status !== 'archived') {
        j.doneAt = Date.now();
        if (proof) j.proofPhotoId = 'proof-' + id;
        if (proofThumb) j.proofThumbId = 'proofth-' + id;
      }
      var pushed = null;
      if (status === 'got' && j.nextTab && !j.nextJobId) {
        uid++;
        var pj = {
          id: 'j' + uid, tab: j.nextTab, category: j.nextCategory || '', note: j.note,
          photoIds: j.photoIds.slice(), thumbIds: j.thumbIds.slice(),
          status: 'pending', createdAt: Date.now(), doneAt: '', proofPhotoId: '', proofThumbId: '',
          dueAt: j.nextDueAt || '', pinnedAt: '', jsCount: 0,
          customer: j.customer, folderId: j.folderId, fromCheck: true,
          nextTab: '', nextCategory: '', nextDueAt: '', nextJobId: ''
        };
        db.jobs.push(pj);
        j.nextJobId = pj.id;
        pushed = JSON.parse(JSON.stringify(pj));
      }
      return { id: id, status: status, doneAt: j.doneAt, proofPhotoId: j.proofPhotoId || '', proofThumbId: j.proofThumbId || '', pushed: pushed };
    }
  };

  window.__mockdb = db;
  window.__mockapi = api;
  window.__mockcalls = [];

  function makeRunner() {
    var r = { _s: null, _f: null };
    r.withSuccessHandler = function (fn) { r._s = fn; return r; };
    r.withFailureHandler = function (fn) { r._f = fn; return r; };
    Object.keys(api).forEach(function (name) {
      r[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        window.__mockcalls.push({ name: name, at: Date.now() });
        var lat = (window.__mocklat && window.__mocklat[name] != null) ? window.__mocklat[name] : LAT;
        // test hook: window.__mockfail = { addJob: 2 } fails the next 2 calls
        if (window.__mockfail && window.__mockfail[name] > 0) {
          window.__mockfail[name]--;
          setTimeout(function () { if (r._f) r._f(new Error('Network glitch')); }, lat);
          return;
        }
        setTimeout(function () {
          try {
            var res = api[name].apply(null, args);
            if (r._s) r._s(res);
          } catch (e) {
            if (r._f) r._f(e);
          }
        }, lat);
      };
    });
    return r;
  }

  window.google = { script: {} };
  Object.defineProperty(window.google.script, 'run', { get: makeRunner });
})();
