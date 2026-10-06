// 配信用の出力のページ（Mac のアプリ、ロードマップ A18 S5）。体のページ（embed）をそのまま読み、アプリから届く呼び出し
// （/events、Server-Sent Events）を写す。自分では何も決めない。届くのは、表情・気分・いまの様子・会話の様子・口・しぐさ・
// 体の名前だけで、言葉もカメラの絵も届かない。届いたものはデータとして読み、知っている名前の関数だけを呼ぶ。
(function () {
  'use strict';

  // embed.html と同じファイルを、同じ順に（ShannonStreamOutputTests が embed.html と照らし合わせる）。
  var SCRIPTS = ['assets.js', 'live2d/live2dcubismcore.min.js', 'live2d/live2d.js', 'embed.js'];
  var CALLS = {
    express: true, expressEmotion: true, setMood: true, setPresence: true,
    setPhase: true, setMouthLevel: true, play: true, setBody: true
  };
  // 新しく見始めたページにも要る、続いている様子。表情・しぐさ・口は、その時だけのもの。
  var LASTING = ['setBody', 'setMood', 'setPresence', 'setPhase'];
  // アプリが動いていない時も、少し待ったら人の姿で出す（アプリが動けば、届いたとおりに直る）。
  var START_WITHOUT_APP_MS = 3000;
  var RELOAD_SPACING_MS = 60000;

  var started = false;
  var ready = false;
  var latest = {};

  function call(name, args) {
    var body = window.shannonBody;
    if (!body || typeof body[name] !== 'function') return;
    try {
      body[name].apply(body, args);
    } catch (error) {
      // 1 つの呼び出しが失敗しても、次は届く。
    }
  }

  function reloadSoon() {
    var now = Date.now();
    var last = 0;
    try {
      last = Number(window.sessionStorage.getItem('shannon.stream.reloadedAt')) || 0;
      window.sessionStorage.setItem('shannon.stream.reloadedAt', String(now));
    } catch (error) {
      last = now;
    }
    window.setTimeout(function () { window.location.reload(); }, now - last < RELOAD_SPACING_MS ? RELOAD_SPACING_MS : 2000);
  }

  // 体のページが知らせること（ready・error など）。WKWebView の口の代わりを、ここで用意する。
  function fromPage(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') {
      ready = true;
      // 配信の画面は触れない。全身を、枠の中に収める（大きさは OBS のブラウザソースの幅・高さで決まる）。
      call('setTouchEnabled', [false]);
      call('setLayout', [{ mode: 'full', fit: 'contain' }]);
      LASTING.forEach(function (name) { if (latest[name]) call(name, latest[name]); });
    } else if (message.type === 'error') {
      reloadSoon();
    }
  }

  var handler = { postMessage: fromPage };
  try {
    window.webkit = { messageHandlers: { shannonBody: handler } };
  } catch (error) {
    // 読み取り専用の環境では、下の console.log で受ける。
  }
  var hooked = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.shannonBody === handler;
  if (!hooked) {
    var log = console.log;
    console.log = function (tag, text) {
      if (tag === '[shannonBody]' && typeof text === 'string') {
        try { fromPage(JSON.parse(text)); } catch (error) { /* 読めない知らせは捨てる */ }
        return;
      }
      return log.apply(console, arguments);
    };
  }

  // 体のページは、始める体を URL（?body=eyes）で読む。分かってから読み込む。
  function start(bodyName) {
    if (started) return;
    started = true;
    try {
      window.history.replaceState(null, '', window.location.pathname + (bodyName === 'eyes' ? '?body=eyes' : ''));
    } catch (error) {
      // 変えられなければ人の姿で始まり、届いた setBody で切り替わる。
    }
    SCRIPTS.forEach(function (source) {
      var script = document.createElement('script');
      script.src = source;
      script.async = false;
      document.body.appendChild(script);
    });
  }

  function receive(event) {
    var message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (!message || typeof message.call !== 'string' || !Object.prototype.hasOwnProperty.call(CALLS, message.call)
        || !Array.isArray(message.args)) return;
    if (LASTING.indexOf(message.call) >= 0) latest[message.call] = message.args;
    if (!started) {
      if (message.call === 'setBody') start(message.args[0]);
      return;
    }
    if (ready) call(message.call, message.args);
  }

  var events = new EventSource('/events');
  events.onmessage = receive;
  window.setTimeout(function () { start(latest.setBody ? latest.setBody[0] : 'human'); }, START_WITHOUT_APP_MS);
})();
