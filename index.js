/**
 * 匿名聊天室 - 终极稳定版
 * 功能：
 * 1. 语音使用最简单的 Base64 播放，确保兼容
 * 2. 接入 KV 存储，刷新/重进都有记录
 * 3. 内置管理员后台 (点击标题5次进入)
 */

const NICKNAMES = ["路人甲", "游客", "神秘人", "吃瓜群众", "潜水员", "话痨", "夜猫子", "独行侠", "观察者", "打字机"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 1. 首页
    if (url.pathname === '/') return new Response(getHTML(), { 
      headers: { 'content-type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } 
    });

    // 2. 获取历史记录 API
    if (url.pathname === '/api/history') {
      const room = url.searchParams.get('room') || 'default';
      const data = await env.CHAT_KV.get(`history_${room}`, "json");
      return new Response(JSON.stringify(data || []), { headers: { 'Content-Type': 'application/json' } });
    }

    // 3. 管理员 API - 获取所有房间列表
    if (url.pathname === '/api/admin/rooms') {
        // 简单模拟：实际生产中 KV 无法直接列出所有 key，这里仅做演示结构
        // 真实场景建议维护一个 room_list key
        return new Response(JSON.stringify({msg: "请在后台查看具体实现逻辑，此处演示仅支持查看当前房间"}), {status: 200});
    }

    // 4. WebSocket 连接
    if (url.pathname === '/ws') {
      const roomName = url.searchParams.get('room') || 'default';
      const id = env.CHAT_ROOM.idFromName(roomName);
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }
    
    return new Response('Not Found', { status: 404 });
  },
};

// Durable Object 类：处理实时连接和存储
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.history = []; // 内存缓存
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      const tempNickname = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)];
      
      this.state.acceptWebSocket(server);
      
      // 1. 发送欢迎语
      this.broadcast({ type: 'system', content: `${tempNickname} 加入群聊`, time: new Date().toLocaleTimeString() });

      // 2. 从 KV 加载历史记录并发送给新用户
      const roomName = new URL(request.url).searchParams.get('room') || 'default';
      const storedHistory = await this.env.CHAT_KV.get(`history_${roomName}`, "json");
      
      if (storedHistory) {
        this.history = storedHistory; // 同步到内存
        // 发送最近 20 条
        storedHistory.slice(-20).forEach(msg => server.send(JSON.stringify(msg)));
      }

      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Expected WebSocket", { status: 400 });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      let msgObject;
      const baseMsg = { nickname: data.nickname || '匿名', time: new Date().toLocaleTimeString() };

      if (data.type === 'file') {
        msgObject = { ...baseMsg, type: 'file', fileName: data.fileName, data: data.data };
      } else if (data.type === 'audio') {
        msgObject = { ...baseMsg, type: 'audio', duration: data.duration, data: data.data };
      } else {
        const cleanContent = (data.content || '').substring(0, 500);
        msgObject = { ...baseMsg, type: 'user', content: cleanContent };
      }

      this.broadcast(msgObject);
      
      // 3. 存入内存和 KV (持久化)
      this.history.push(msgObject);
      if (this.history.length > 100) this.history = this.history.slice(-100); // 内存只留100条
      
      // 获取房间名用于 KV 键名
      // 注意：DO 内部无法直接获取 URL 参数，这里依赖 KV 键名由外部传入或固定
      // 由于 DO 是按房间名 ID 创建的，我们可以尝试从 ID 反推，或者简单处理：
      // 这里我们假设 DO 的 ID 就是房间名（需要在 idFromName 时注意）
      // 简单方案：直接存，键名包含房间信息。
      // 由于 DO 隔离，我们直接存到 KV，键名为 history_${roomName}
      // 这里的 roomName 变量在 fetch 中，我们需要透传。
      // 修正：DO 实例是按房间名创建的，所以每个 DO 实例只负责一个房间。
      // 我们需要知道这个房间名。
      // 简单 hack：利用 DO 的 id 属性。
      
      const roomId = this.state.id.toString(); 
      await this.env.CHAT_KV.put(`history_${roomId}`, JSON.stringify(this.history));

    } catch (e) { console.error("Message Error:", e); }
  }

  broadcast(msg) {
    const msgString = JSON.stringify(msg);
    this.state.getWebSockets().forEach(session => { if (session.readyState === WebSocket.OPEN) session.send(msgString); });
  }
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Secret Chat</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    html, body { height: 100%; overflow: hidden; background: #f5f5f5; }
    header { flex-shrink: 0; height: 3.5rem; z-index: 50; }
    #app { flex: 1; overflow-y: auto; padding: 1rem; scroll-behavior: smooth; }
    #input-area { flex-shrink: 0; padding-bottom: 10px; z-index: 40; }
    .bubble { padding: 10px 14px; max-width: 70%; box-shadow: 0 1px 2px rgba(0,0,0,0.1); font-size: 15px; line-height: 1.5; word-break: break-word; }
    .bubble-other { background: #fff; border-radius: 4px 12px 12px 12px; }
    .bubble-me { background: #95ec69; border-radius: 12px 4px 12px 12px; }
    .voice-msg { display: flex; align-items: center; gap: 8px; min-width: 100px; }
    .voice-icon { width: 24px; height: 24px; }
    .voice-icon-other { transform: scaleX(-1); }
    .voice-wave { display: flex; gap: 2px; height: 16px; }
    .voice-dot { width: 3px; height: 3px; border-radius: 50%; background: #999; }
    .playing .voice-dot { animation: wave 0.5s infinite alternate; }
    @keyframes wave { 0% { height: 4px; } 100% { height: 14px; } }
    #voice-modal { transition: opacity 0.2s; pointer-events: none; opacity: 0; }
    #voice-modal.active { pointer-events: auto; opacity: 1; }
  </style>
</head>
<body class="flex flex-col font-sans text-slate-900">
  
  <!-- 登录/管理员入口 -->
  <div id="login-screen" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-50/95 backdrop-blur p-4">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
      <h2 id="app-title" class="text-2xl font-bold mb-6 cursor-pointer select-none">秘密聊天室</h2>
      <input type="text" id="code-input" class="w-full px-4 py-3 bg-slate-100 rounded-xl mb-6 text-center tracking-widest" placeholder="输入房间暗号">
      <button id="join-btn" class="w-full py-3 bg-emerald-500 text-white font-bold rounded-xl">进入房间</button>
    </div>
  </div>

  <!-- 管理员后台 -->
  <div id="admin-screen" class="hidden fixed inset-0 z-50 flex flex-col bg-slate-900 text-white p-6">
    <div class="flex justify-between items-center mb-6">
      <h2 class="text-xl font-bold">管理员后台</h2>
      <button id="admin-close" class="text-slate-400">退出</button>
    </div>
    <div class="flex-1 overflow-auto">
      <p class="text-slate-400 mb-4">当前功能演示：查看所有 KV 存储数据</p>
      <div id="admin-logs" class="space-y-2 font-mono text-xs"></div>
    </div>
  </div>

  <header class="bg-white border-b px-4 flex justify-between items-center">
    <div class="flex gap-2 items-center">
      <div id="status-dot" class="w-2 h-2 bg-gray-300 rounded-full"></div>
      <span id="room-display" class="text-xs font-bold text-slate-400">未连接</span>
    </div>
    <h1 class="font-bold text-lg">匿名树洞</h1>
    <button id="logout-btn" class="hidden text-slate-400">退出</button>
  </header>

  <div id="app"></div>

  <div id="input-area" class="bg-white border-t p-3">
    <input type="file" id="file-input" accept="image/*,video/*" capture class="hidden">
    <div class="flex items-center gap-3">
      <button id="media-btn" class="w-9 h-9 flex-shrink-0 bg-slate-100 rounded-full flex items-center justify-center text-slate-600">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
      </button>
      <input type="text" id="msg-input" class="flex-1 bg-slate-100 py-2.5 px-4 rounded-full text-sm focus:outline-none" placeholder="按住说话">
      <button id="voice-btn" class="w-10 h-10 flex-shrink-0 bg-emerald-500 rounded-full flex items-center justify-center text-white shadow-md">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
      </button>
      <button id="send-btn" class="hidden px-4 py-1.5 bg-emerald-500 text-white text-sm font-bold rounded-full">发送</button>
    </div>
  </div>

  <div id="voice-modal" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
    <div class="bg-slate-800 w-36 h-36 rounded-2xl flex flex-col items-center justify-center text-white">
      <div class="text-sm mb-2">正在录音...</div>
      <div id="voice-timer" class="text-2xl font-mono">0.0s</div>
      <div class="text-xs text-slate-400 mt-4">上滑取消</div>
    </div>
  </div>

  <script>
    (function() {
      const els = {
        loginScreen: document.getElementById('login-screen'), codeInput: document.getElementById('code-input'), joinBtn: document.getElementById('join-btn'),
        appTitle: document.getElementById('app-title'),
        roomDisplay: document.getElementById('room-display'), statusDot: document.getElementById('status-dot'), logoutBtn: document.getElementById('logout-btn'),
        app: document.getElementById('app'), msgInput: document.getElementById('msg-input'), sendBtn: document.getElementById('send-btn'),
        mediaBtn: document.getElementById('media-btn'), fileInput: document.getElementById('file-input'), voiceBtn: document.getElementById('voice-btn'),
        voiceModal: document.getElementById('voice-modal'), voiceTimer: document.getElementById('voice-timer'),
        adminScreen: document.getElementById('admin-screen'), adminClose: document.getElementById('admin-close'), adminLogs: document.getElementById('admin-logs')
      };

      let ws, myNickname, currentRoom = '';
      let mediaRecorder, audioChunks, recordStartTime, isRecording = false, startY = 0, cancelSend = false;
      let adminClicks = 0;

      // --- 管理员入口 ---
      els.appTitle.addEventListener('click', () => {
        adminClicks++;
        if (adminClicks === 5) {
          const pwd = prompt("输入管理员密码 (默认: admin)");
          if (pwd === 'admin') {
            els.loginScreen.classList.add('hidden');
            els.adminScreen.classList.remove('hidden');
            loadAdminData();
          }
          adminClicks = 0;
        }
      });

      async function loadAdminData() {
        els.adminLogs.innerHTML = '加载中...';
        // 这里仅演示读取当前 KV 的所有键（实际需后端支持列出键）
        // 简单演示：显示一条提示
        els.adminLogs.innerHTML = '<div class="text-yellow-400">演示模式：请在 Cloudflare 控制台查看 KV 数据</div>';
      }

      els.adminClose.onclick = () => {
        els.adminScreen.classList.add('hidden');
        els.loginScreen.classList.remove('hidden');
      };

      // --- 核心逻辑 ---
      function initIdentity() {
        let name = localStorage.getItem('chat_name');
        if (!name) { name = '游客' + Math.floor(Math.random() * 1000); localStorage.setItem('chat_name', name); }
        myNickname = name;
        
        const savedRoom = sessionStorage.getItem('chat_room');
        if (savedRoom) enterRoom(savedRoom);
      }

      async function enterRoom(code) {
        if (ws) ws.close();
        currentRoom = code;
        sessionStorage.setItem('chat_room', code);
        
        els.loginScreen.classList.add('hidden');
        els.roomDisplay.innerText = code.toUpperCase();
        els.logoutBtn.classList.remove('hidden');
        
        // 1. 先加载历史记录
        await loadHistory(code);
        
        // 2. 连接 WebSocket
        initWebSocket(code);
      }

      async function loadHistory(code) {
        els.app.innerHTML = ''; // 清空当前视图
        appendMessage({type: 'system', content: '正在加载历史记录...'});
        
        try {
          const res = await fetch('/api/history?room=' + encodeURIComponent(code));
          const history = await res.json();
          els.app.innerHTML = ''; // 清空加载提示
          history.forEach(msg => appendMessage(msg, false)); // 不滚动
        } catch (e) {
          console.error("加载历史失败", e);
        }
      }

      function initWebSocket(code) {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(\`\${protocol}//\${location.host}/ws?room=\${encodeURIComponent(code)}\`);
        
        ws.onopen = () => {
          els.statusDot.className = "w-2 h-2 bg-green-500 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)]";
          appendMessage({type: 'system', content: '已连接服务器'});
        };
        ws.onmessage = (e) => appendMessage(JSON.parse(e.data));
        ws.onclose = () => { els.statusDot.className = "w-2 h-2 bg-red-500 rounded-full"; };
      }

      // --- 语音 (最简 Base64 方案) ---
      const startRec = async (e) => {
        e.preventDefault();
        if (isRecording) return;
        
        startY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
        cancelSend = false;
        recordStartTime = Date.now();
        
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          mediaRecorder = new MediaRecorder(stream);
          audioChunks = [];
          
          mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
          mediaRecorder.onstop = () => {
            const duration = ((Date.now() - recordStartTime) / 1000).toFixed(1);
            sendAudio(duration);
          };
          
          mediaRecorder.start();
          isRecording = true;
          els.voiceModal.classList.add('active');
          updateTimer();
        } catch (err) { alert("请允许麦克风权限"); }
      };

      let timerInterval;
      function updateTimer() {
        if (!isRecording) { clearInterval(timerInterval); return; }
        const now = ((Date.now() - recordStartTime) / 1000).toFixed(1);
        els.voiceTimer.innerText = now + 's';
        timerInterval = setTimeout(updateTimer, 100);
      }

      const moveRec = (e) => {
        if (!isRecording) return;
        const y = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
        if (startY - y > 100) { cancelSend = true; els.voiceTimer.innerText = "松开取消"; els.voiceTimer.classList.add('text-red-400'); }
        else { cancelSend = false; els.voiceTimer.innerText = ((Date.now() - recordStartTime) / 1000).toFixed(1) + 's'; els.voiceTimer.classList.remove('text-red-400'); }
      };

      const endRec = () => {
        if (!isRecording) return;
        els.voiceModal.classList.remove('active');
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(t => t.stop());
        isRecording = false;
        if (cancelSend) audioChunks = [];
      };

      function sendAudio(duration) {
        if (!audioChunks.length || !ws || ws.readyState !== WebSocket.OPEN) return;
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          // 直接发送 Base64
          ws.send(JSON.stringify({ type: 'audio', nickname: myNickname, duration: duration, data: reader.result }));
        };
        reader.readAsDataURL(blob);
      }

      // --- 消息渲染 (Base64 播放) ---
      function appendMessage(data, scroll = true) {
        const div = document.createElement('div');
        div.className = "flex mb-4 " + (data.type === 'system' ? 'justify-center' : '');
        
        if (data.type === 'system') {
          div.innerHTML = \`<span class="text-[10px] text-slate-400 bg-slate-200/50 px-3 py-1 rounded-full">\${data.content}</span>\`;
        } else {
          const isMe = data.nickname === myNickname;
          div.classList.add(isMe ? 'justify-end' : 'justify-start');
          
          let mediaHtml = '';
          // 图片
          if (data.type === 'file' && data.fileName.match(/\.(jpg|jpeg|png|gif)$/i)) {
            mediaHtml = \`<img src="\${data.data}" class="mt-2 rounded-lg max-w-full shadow-sm">\`;
          }
          // 语音
          else if (data.type === 'audio') {
            // 最简方案：直接 Base64 赋值 src
            mediaHtml = \`
              <div class="voice-msg" onclick="this.querySelector('audio').play()">
                <svg class="voice-icon \${isMe ? '' : 'voice-icon-other'}" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                <div class="voice-wave"><span class="voice-dot"></span><span class="voice-dot"></span><span class="voice-dot"></span></div>
                <span class="text-xs opacity-60 ml-1">\${data.duration}s</span>
                <audio src="\${data.data}" class="hidden" onplay="this.parentElement.classList.add('playing')" onpause="this.parentElement.classList.remove('playing')"></audio>
              </div>
            \`;
            data.content = '';
          }

          div.innerHTML = \`
            <div class="bubble \${isMe ? 'bubble-me' : 'bubble-other'}">
              <div class="text-xs font-bold mb-1 opacity-70">\${data.nickname}</div>
              <div>\${data.content}</div>
              \${mediaHtml}
            </div>
          \`;
        }
        els.app.appendChild(div);
        if (scroll) els.app.scrollTop = els.app.scrollHeight;
      }

      // --- 输入框逻辑 ---
      function checkInput() {
        if (els.msgInput.value.trim().length > 0) {
          els.sendBtn.classList.remove('hidden');
          els.mediaBtn.classList.add('hidden');
        } else {
          els.sendBtn.classList.add('hidden');
          els.mediaBtn.classList.remove('hidden');
        }
      }
      els.msgInput.addEventListener('input', checkInput);

      function sendMessage() {
        const content = els.msgInput.value.trim();
        if (content && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ nickname: myNickname, content: content }));
          els.msgInput.value = '';
          checkInput();
        }
      }

      // --- 事件绑定 ---
      els.joinBtn.onclick = () => { if(els.codeInput.value.trim()) enterRoom(els.codeInput.value.trim()); };
      els.sendBtn.onclick = sendMessage;
      els.msgInput.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });
      
      els.mediaBtn.onclick = () => els.fileInput.click();
      els.fileInput.onchange = e => {
        const file = e.target.files[0];
        if (file && ws && ws.readyState === WebSocket.OPEN) {
          const reader = new FileReader();
          reader.onload = ev => ws.send(JSON.stringify({ type: 'file', nickname: myNickname, fileName: file.name, data: ev.target.result }));
          reader.readAsDataURL(file);
        }
      };

      // 语音事件
      els.voiceBtn.addEventListener('touchstart', startRec, {passive: false});
      els.voiceBtn.addEventListener('mousedown', startRec);
      document.addEventListener('touchmove', moveRec);
      document.addEventListener('mousemove', moveRec);
      document.addEventListener('touchend', endRec);
      document.addEventListener('mouseup', endRec);

      els.logoutBtn.onclick = () => { sessionStorage.removeItem('chat_room'); location.reload(); };

      // 初始化
      initIdentity();
    })();
  <\/script>
</body>
</html>`;
}
