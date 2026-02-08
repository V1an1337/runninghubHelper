// ==UserScript==
// @name         RunningHub.ai Create Request Template & Replay + 资源库（调试增强版）
// @namespace    http://tampermonkey.net/
// @version      1.3.1
// @description  捕获 create 请求保存模板（保存 webappId/referrer，不保存 token），支持编辑 token/fieldValue 并重发；自动捕获上传资源到资源库；模板库/资源库两 Tab 管理。
// @author       Grok
// @match        https://www.runninghub.ai/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // run-at=document-start: 先缓存通知，等 body 出现再显示（var 避免 TDZ）
    var __pendingNotifications = [];
    console.log('%c[RunningHub 工具] 脚本已加载', 'color:orange;font-weight:bold;font-size:16px;');

    // 脚本加载成功通知（确保用户知道脚本已运行）
    showNotification('RunningHub 工具已加载！右下角有控制面板（如果看不到请检查 Tampermonkey 是否启用）');

    const LEGACY_TEMPLATE_KEY = 'runninghub_last_create_template';
    const TEMPLATES_KEY = 'runninghub_templates';
    const LAST_TEMPLATE_ID_KEY = 'runninghub_last_template_id';
    const RESOURCES_KEY = 'runninghub_resources';

    // Do not persist token. We only keep it in-memory for convenience.
    let lastCapturedToken = '';

    // v2: 捕获 create / upload（兼容 fetch + XHR，优先注入到页面上下文）
    // More tolerant matching: RunningHub 可能调整路径，先用宽松规则保证“能抓到”，再按需收紧。
    const RH_CREATE_RE = /\/task\/webapp\/create\b|\/create\b/i;
    const RH_UPLOAD_RE = /\/upload\b/i;
    const RH_NET_EVENT = '__runninghub_net_hook__';
    const RH_PM_SOURCE = '__runninghub_hook_pm__';
    let rhPageHookReady = false;

    function rhToAbs(urlLike) {
        try {
            return new URL(String(urlLike || ''), location.href).href;
        } catch (e) {
            return String(urlLike || '');
        }
    }

    function rhHeadersToPlain(headers) {
        const out = {};
        try {
            if (!headers) return out;

            if (typeof Headers !== 'undefined' && headers instanceof Headers) {
                headers.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
                return out;
            }

            if (Array.isArray(headers)) {
                headers.forEach(pair => {
                    if (!pair || pair.length < 2) return;
                    out[String(pair[0]).toLowerCase()] = String(pair[1]);
                });
                return out;
            }

            if (typeof headers === 'object') {
                Object.keys(headers).forEach(k => { out[String(k).toLowerCase()] = String(headers[k]); });
                return out;
            }
        } catch (e) {}
        return out;
    }

    function rhSafeBody(body) {
        if (typeof body === 'string') return body;
        try {
            if (body && typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
            if (body && typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]';
            if (body && typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob size=${body.size}]`;
        } catch (e) {}
        if (body == null) return null;
        if (typeof body === 'object') return '[Object]';
        return String(body);
    }

    function rhGenerateId() {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        } catch (e) {}
        return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    }

    function rhGetTemplates() {
        const list = GM_getValue(TEMPLATES_KEY, []);
        return Array.isArray(list) ? list : [];
    }

    function rhSaveTemplates(list) {
        GM_setValue(TEMPLATES_KEY, Array.isArray(list) ? list : []);
    }

    function rhSetLastTemplateId(id) {
        GM_setValue(LAST_TEMPLATE_ID_KEY, id || '');
    }

    function rhGetLastTemplateId() {
        const v = GM_getValue(LAST_TEMPLATE_ID_KEY, '');
        return typeof v === 'string' ? v : '';
    }

    function rhFindTemplateById(id) {
        if (!id) return null;
        return rhGetTemplates().find(t => t && t.id === id) || null;
    }

    function rhUpsertTemplate(nextTemplate) {
        const list = rhGetTemplates();
        const idx = list.findIndex(t => t && t.id === nextTemplate.id);
        if (idx >= 0) list.splice(idx, 1);
        list.unshift(nextTemplate);
        rhSaveTemplates(list);
        rhSetLastTemplateId(nextTemplate.id);
    }

    function rhDeleteTemplate(id) {
        const list = rhGetTemplates().filter(t => t && t.id !== id);
        rhSaveTemplates(list);
        if (rhGetLastTemplateId() === id) rhSetLastTemplateId(list[0] ? list[0].id : '');
    }

    function rhUpdateTemplateName(id, name) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        const list = rhGetTemplates();
        const idx = list.findIndex(t => t && t.id === id);
        if (idx < 0) return;
        list[idx] = {
            ...list[idx],
            name: trimmed || list[idx].name,
            updatedAt: new Date().toISOString()
        };
        rhSaveTemplates(list);
    }

    function rhExtractWebappIdFromAiDetail(urlLike) {
        try {
            const u = new URL(String(urlLike || ''), location.href);
            const m = u.pathname.match(/\/ai-detail\/([^/?#]+)/i);
            return m ? m[1] : '';
        } catch (e) {
            return '';
        }
    }

    function rhTryParseJson(text) {
        try {
            return JSON.parse(text);
        } catch (e) {
            return null;
        }
    }

    function rhBuildReferrerFromWebappId(webappId) {
        if (!webappId) return '';
        return `https://www.runninghub.ai/ai-detail/${webappId}`;
    }

    function rhFilterHeadersForReplay(headersPlain) {
        const out = {};
        const h = headersPlain && typeof headersPlain === 'object' ? headersPlain : {};

        // Keep only headers that are safe/necessary to replay. Avoid forbidden headers (sec-*, priority, etc.).
        const allow = new Set([
            'accept',
            'accept-language',
            'content-type',
            'user-language'
        ]);

        Object.keys(h).forEach(k => {
            const key = String(k).toLowerCase();
            if (key === 'authorization') return;
            if (key.startsWith('sec-')) return;
            if (key === 'priority') return;
            if (key === 'referer' || key === 'referrer') return; // use fetch option referrer instead

            if (allow.has(key) || key.startsWith('x-')) out[key] = String(h[k]);
        });

        return out;
    }

    function rhMigrateLegacyTemplateOnce() {
        try {
            const legacy = GM_getValue(LEGACY_TEMPLATE_KEY, '');
            if (!legacy) return;

            let parsed = null;
            if (typeof legacy === 'string') parsed = rhTryParseJson(legacy);
            else if (legacy && typeof legacy === 'object') parsed = legacy;
            if (!parsed || typeof parsed !== 'object') return;

            const rawHeaders = rhHeadersToPlain(parsed.headers);
            const bodyStr = typeof parsed.body === 'string' ? parsed.body : rhSafeBody(parsed.body);
            const bodyObj = typeof bodyStr === 'string' ? rhTryParseJson(bodyStr) : null;

            const webappIdFromBody = bodyObj && typeof bodyObj.webappId === 'string' ? bodyObj.webappId : '';
            const webappIdFromReferrer = parsed.referrer ? rhExtractWebappIdFromAiDetail(parsed.referrer) : '';
            const webappId = webappIdFromBody || webappIdFromReferrer || '';
            const referrer = rhBuildReferrerFromWebappId(webappId) || (typeof parsed.referrer === 'string' ? parsed.referrer : '');

            const requestData = {
                url: rhToAbs(parsed.url),
                method: parsed.method || 'GET',
                headers: rhFilterHeadersForReplay(rawHeaders),
                body: bodyStr,
                credentials: parsed.credentials || 'include',
                mode: parsed.mode || 'cors',
                referrer
            };

            const nowIso = new Date().toISOString();
            const existing = webappId ? rhGetTemplates().find(t => t && t.webappId === webappId) : null;

            const template = {
                id: existing ? existing.id : rhGenerateId(),
                name: (existing && existing.name) ? existing.name : (webappId ? `迁移模板 ${webappId}` : `迁移模板 ${new Date().toLocaleString()}`),
                webappId,
                referrer,
                request: requestData,
                createdAt: existing && existing.createdAt ? existing.createdAt : nowIso,
                updatedAt: nowIso
            };

            rhUpsertTemplate(template);
            GM_setValue(LEGACY_TEMPLATE_KEY, '');
            console.log('%c[RunningHub] legacy template migrated to templates library', 'color:#1565c0;font-weight:bold;', template);
            showNotification('已迁移旧版模板到模板库（不再保存 token）。');
        } catch (e) {
            // Ignore migration failures; do not block the script.
        }
    }

    function rhSaveCreateTemplate(req) {
        try {
            const rawHeaders = rhHeadersToPlain(req.headers);
            const authHeader = rawHeaders.authorization || rawHeaders.Authorization || '';
            if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
                lastCapturedToken = authHeader.slice('Bearer '.length).trim();
            } else {
                lastCapturedToken = '';
            }

            const bodyStr = rhSafeBody(req.body);
            const bodyObj = typeof bodyStr === 'string' ? rhTryParseJson(bodyStr) : null;
            const webappIdFromBody = bodyObj && typeof bodyObj.webappId === 'string' ? bodyObj.webappId : '';
            const webappIdFromReqReferrer = (req && typeof req.referrer === 'string') ? rhExtractWebappIdFromAiDetail(req.referrer) : '';
            const webappIdFromUrl = rhExtractWebappIdFromAiDetail(location.href);
            const webappId = webappIdFromBody || webappIdFromReqReferrer || webappIdFromUrl;
            const referrer = rhBuildReferrerFromWebappId(webappId) || (typeof req.referrer === 'string' ? req.referrer : '');

            const requestData = {
                url: rhToAbs(req.url),
                method: req.method || 'GET',
                headers: rhFilterHeadersForReplay(rawHeaders),
                body: bodyStr,
                credentials: req.credentials || 'include',
                mode: req.mode || 'cors',
                referrer
            };

            const nowIso = new Date().toISOString();
            const existing = webappId ? rhGetTemplates().find(t => t && t.webappId === webappId) : null;
            const template = {
                id: existing ? existing.id : rhGenerateId(),
                name: existing ? existing.name : (webappId ? `模板 ${webappId}` : `模板 ${new Date().toLocaleString()}`),
                webappId,
                referrer,
                request: requestData,
                createdAt: existing && existing.createdAt ? existing.createdAt : nowIso,
                updatedAt: nowIso
            };

            rhUpsertTemplate(template);
            console.log('%c[RunningHub Template] 已捕获 create 请求并保存到模板库', 'color:green;font-weight:bold;font-size:14px;', template);
            showNotification(`已捕获 create 模板：${template.name}`);
        } catch (e) {
            console.warn('[RunningHub Template] 保存失败', e);
        }
    }

    function rhAddUploadResource(resp) {
        try {
            const json = resp && resp.json && typeof resp.json === 'object' ? resp.json : null;
            const name = json ? (json.name || (json.data && json.data.name) || (json.result && json.result.name) || json.fileName || json.filename) : null;
            if (!name || typeof name !== 'string') return;

            function pickUrl(obj) {
                if (!obj || typeof obj !== 'object') return '';
                const directKeys = ['url', 'downloadUrl', 'fileUrl', 'imageUrl', 'previewUrl', 'path', 'filePath', 'link', 'href'];
                for (const k of directKeys) {
                    const v = obj[k];
                    if (typeof v === 'string' && v.trim()) return v.trim();
                }
                const nests = [obj.data, obj.result, obj.file, obj.payload];
                for (const n of nests) {
                    if (!n || typeof n !== 'object') continue;
                    for (const k of directKeys) {
                        const v = n[k];
                        if (typeof v === 'string' && v.trim()) return v.trim();
                    }
                }
                return '';
            }

            let url = pickUrl(json);
            if (url) {
                try {
                    url = new URL(url, location.origin).href;
                } catch (e) {}
            }

            const resources = rhGetResources();
            if (resources.some(r => r && r.name === name)) return;

            const next = [{ name, url: url || '', addedAt: new Date().toISOString() }, ...resources];
            rhSaveResources(next);
            console.log('%c[RunningHub 资源库] 添加资源: ' + name, 'color:purple;font-weight:bold;font-size:14px;');
            showNotification('资源已添加: ' + name.substring(0, 30) + '...（可在资源库查看）');
        } catch (e) {}
    }

    window.addEventListener(RH_NET_EVENT, ev => {
        try {
            const d = ev && ev.detail ? ev.detail : null;
            if (!d || typeof d !== 'object') return;
            if (d.type === 'create' && d.request) rhSaveCreateTemplate(d.request);
            if (d.type === 'upload' && d.response) rhAddUploadResource(d.response);
        } catch (e) {}
    });

    // Page <-> userscript bridge: more reliable than CustomEvent across sandboxes.
    window.addEventListener('message', ev => {
        try {
            if (!ev || ev.source !== window) return;
            const data = ev.data;
            if (!data || typeof data !== 'object') return;
            if (data.source !== RH_PM_SOURCE) return;

            if (data.type === 'hook-ready') {
                rhPageHookReady = true;
                console.log('%c[RunningHub] page hook ready', 'color:#1565c0;font-weight:bold;');
                return;
            }

            if (data.type === 'create' && data.request) rhSaveCreateTemplate(data.request);
            if (data.type === 'upload' && data.response) rhAddUploadResource(data.response);
        } catch (e) {}
    });

    function rhInjectPageHook() {
        try {
            const script = document.createElement('script');
            script.textContent = `(function(){
  // Allow upgrading hook logic across script updates
  if (window.__runninghub_net_hook_installed__ === 2) return;
  window.__runninghub_net_hook_installed__ = 2;

  const CREATE_RE = ${RH_CREATE_RE.toString()};
  const UPLOAD_RE = ${RH_UPLOAD_RE.toString()};
  const EV = ${JSON.stringify(RH_NET_EVENT)};
  const PM_SOURCE = ${JSON.stringify(RH_PM_SOURCE)};

  function toAbs(u){ try { return new URL(String(u||''), location.href).href; } catch(e){ return String(u||''); } }
  function headersToPlain(h){
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach((v,k)=>out[String(k).toLowerCase()]=String(v)); return out; }
      if (Array.isArray(h)) { h.forEach(p=>{ if(p&&p.length>=2) out[String(p[0]).toLowerCase()]=String(p[1]);}); return out; }
      if (typeof h === 'object') { Object.keys(h).forEach(k=>out[String(k).toLowerCase()]=String(h[k])); return out; }
    } catch(e) {}
    return out;
  }
  function safeBody(b){
    if (typeof b === 'string') return b;
    try {
      if (b && typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
      if (b && typeof FormData !== 'undefined' && b instanceof FormData) return '[FormData]';
      if (b && typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob]';
    } catch(e) {}
    if (b == null) return null;
    if (typeof b === 'object') return '[Object]';
    return String(b);
  }
  function emit(detail){
    try { window.dispatchEvent(new CustomEvent(EV, { detail })); } catch(e) {}
    try { window.postMessage(Object.assign({ source: PM_SOURCE }, detail), '*'); } catch(e) {}
  }

  try {
    window.postMessage({ source: PM_SOURCE, type: 'hook-ready' }, '*');
  } catch(e) {}

  // fetch
  try {
    // Wrap even if already wrapped by older versions
    const origFetch = window.fetch;
    if (typeof origFetch === 'function' && !origFetch.__rh_emit_wrapped__) {
      const wrapped = function(resource, init){
        const url = toAbs(typeof resource === 'string' ? resource : (resource && resource.url));
        const method = (init && init.method) || (resource && resource.method) || 'GET';
        const headers = (init && init.headers) || (resource && resource.headers) || {};
        const body = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : undefined;
        const referrer = init && Object.prototype.hasOwnProperty.call(init, 'referrer') ? init.referrer : undefined;
        const credentials = (init && init.credentials) || 'include';
        const mode = (init && init.mode) || 'cors';

        if (url && CREATE_RE.test(url)) {
          emit({ type:'create', request:{ url, method, headers: headersToPlain(headers), body: safeBody(body), referrer, credentials, mode, via:'fetch' } });
        }

        const p = origFetch.apply(this, arguments);
        if (url && UPLOAD_RE.test(url)) {
          p.then(resp => {
            try {
              resp.clone().json()
                .then(json => emit({ type:'upload', response:{ url, status: resp.status, json, via:'fetch' } }))
                .catch(()=>{});
            } catch(e) {}
          }).catch(()=>{});
        }
        return p;
      };
      wrapped.__rh_emit_wrapped__ = true;
      window.fetch = wrapped;
      try { origFetch.__rh_emit_wrapped__ = true; } catch(e) {}
    }
  } catch(e) {}

  // XHR
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__rh_emit_wrapped__) {
      const oOpen = XHR.prototype.open;
      const oSend = XHR.prototype.send;
      const oSet = XHR.prototype.setRequestHeader;

      XHR.prototype.open = function(method, url){
        try { this.__rh = { method: method || 'GET', url: toAbs(url), headers: {} }; } catch(e) {}
        return oOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function(name, value){
        try { if (this.__rh && name) this.__rh.headers[String(name).toLowerCase()] = String(value); } catch(e) {}
        return oSet.apply(this, arguments);
      };
      XHR.prototype.send = function(body){
        try {
          if (this.__rh) {
            const url = this.__rh.url || '';
            if (url && CREATE_RE.test(url)) {
              emit({ type:'create', request:{ url, method: this.__rh.method, headers: this.__rh.headers, body: safeBody(body), credentials: this.withCredentials ? 'include' : 'omit', mode:'cors', via:'xhr' } });
            }
            if (url && UPLOAD_RE.test(url)) {
              this.addEventListener('loadend', () => {
                try {
                  const text = this.responseText;
                  if (!text) return;
                  const json = JSON.parse(text);
                  emit({ type:'upload', response:{ url, status: this.status, json, via:'xhr' } });
                } catch(e) {}
              }, { once:true });
            }
          }
        } catch(e) {}
        return oSend.apply(this, arguments);
      };

      XHR.prototype.__rh_emit_wrapped__ = true;
    }
  } catch(e) {}
})();`;

            (document.head || document.documentElement).appendChild(script);
            script.remove();
            return true;
        } catch (e) {
            return false;
        }
    }

    // 绝大多数情况下，注入能抓到页面里真正的请求；如果 CSP 阻止注入，再尝试 direct hook 兜底。
    const rhInjectedOk = rhInjectPageHook();

    if (!rhInjectedOk) {
        console.warn('[RunningHub] 注入 hook 失败（可能是 CSP），将继续使用原逻辑/兜底（可能抓不到页面请求）');
    } else {
        console.log('%c[RunningHub] 网络 hook 已安装（create/upload 将可捕获）', 'color:blue;font-weight:bold;');
    }

    // One-time migration of older single-template storage into the new templates library.
    rhMigrateLegacyTemplateOnce();

    // v2.1: direct hook 兜底（只在 page hook 没 ready 的情况下启用，避免重复捕获）
    function rhInstallDirectHooks(pageWin) {
        if (!pageWin) return { fetch: false, xhr: false };

        const result = { fetch: false, xhr: false };

        // fetch
        try {
            const origFetch = pageWin.fetch;
            // Wrap current fetch (even if already wrapped), but mark our own wrapper.
            if (typeof origFetch === 'function' && !origFetch.__rh_direct_wrapped__) {
                const wrapped = function (resource, init) {
                    const url = rhToAbs(typeof resource === 'string' ? resource : (resource && resource.url));
                    const method = (init && init.method) || (resource && resource.method) || 'GET';
                    const headers = (init && init.headers) || (resource && resource.headers) || {};
                    const body = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : undefined;
                    const credentials = (init && init.credentials) || 'include';
                    const mode = (init && init.mode) || 'cors';

                    if (url && RH_CREATE_RE.test(url)) {
                        rhSaveCreateTemplate({ url, method, headers, body, credentials, mode, via: 'fetch-direct' });
                    }

                    const p = origFetch.apply(this, arguments);
                    if (url && RH_UPLOAD_RE.test(url)) {
                        p.then(resp => {
                            try {
                                resp.clone().json()
                                    .then(json => rhAddUploadResource({ url, status: resp.status, json, via: 'fetch-direct' }))
                                    .catch(() => {});
                            } catch (e) {}
                        }).catch(() => {});
                    }
                    return p;
                };
                wrapped.__rh_direct_wrapped__ = true;
                try { origFetch.__rh_direct_wrapped__ = true; } catch (e) {}
                pageWin.fetch = wrapped;
                result.fetch = true;
            }
        } catch (e) {}

        // XHR (axios)
        try {
            const XHR = pageWin.XMLHttpRequest;
            if (XHR && XHR.prototype && !XHR.prototype.__rh_direct_wrapped__) {
                const oOpen = XHR.prototype.open;
                const oSend = XHR.prototype.send;
                const oSet = XHR.prototype.setRequestHeader;

                XHR.prototype.open = function (method, url) {
                    try {
                        this.__rh = { method: method || 'GET', url: rhToAbs(url), headers: {} };
                    } catch (e) {}
                    return oOpen.apply(this, arguments);
                };

                XHR.prototype.setRequestHeader = function (name, value) {
                    try {
                        if (this.__rh && name) this.__rh.headers[String(name).toLowerCase()] = String(value);
                    } catch (e) {}
                    return oSet.apply(this, arguments);
                };

                XHR.prototype.send = function (body) {
                    try {
                        if (this.__rh) {
                            const url = this.__rh.url || '';
                            if (url && RH_CREATE_RE.test(url)) {
                                rhSaveCreateTemplate({
                                    url,
                                    method: this.__rh.method,
                                    headers: this.__rh.headers,
                                    body,
                                    credentials: this.withCredentials ? 'include' : 'omit',
                                    mode: 'cors',
                                    via: 'xhr-direct'
                                });
                            }

                            if (url && RH_UPLOAD_RE.test(url)) {
                                this.addEventListener('loadend', () => {
                                    try {
                                        const text = this.responseText;
                                        if (!text) return;
                                        const json = JSON.parse(text);
                                        rhAddUploadResource({ url, status: this.status, json, via: 'xhr-direct' });
                                    } catch (e) {}
                                }, { once: true });
                            }
                        }
                    } catch (e) {}
                    return oSend.apply(this, arguments);
                };

                XHR.prototype.__rh_direct_wrapped__ = true;
                result.xhr = true;
            }
        } catch (e) {}

        return result;
    }

    // Inject first, then wait for hook-ready; if not ready, enable direct fallback.
    setTimeout(() => {
        if (rhPageHookReady) return;

        let installed = { fetch: false, xhr: false };
        try {
            // eslint-disable-next-line no-undef
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow) installed = rhInstallDirectHooks(unsafeWindow);
        } catch (e) {}
        if (!installed.fetch && !installed.xhr) installed = rhInstallDirectHooks(window);

        console.log(
            '%c[RunningHub] direct hook fallback enabled (no page hook ready)',
            'color:#1565c0;font-weight:bold;',
            installed
        );
    }, 1000);

    // run-at=document-start: body 可能还不存在，先队列，等 DOMReady 再显示
    function showNotification(msg) {
        if (!document.body) {
            __pendingNotifications.push(msg);
            return;
        }

        const noti = document.createElement('div');
        noti.textContent = msg;
        noti.style.cssText = `
            position:fixed;top:20px;left:50%;transform:translateX(-50%);
            background:#2196f3;color:white;padding:12px 24px;border-radius:6px;
            z-index:10001;font-size:15px;box-shadow:0 4px 16px rgba(0,0,0,0.4);
            max-width:80%;text-align:center;word-wrap:break-word;
        `;
        document.body.appendChild(noti);
        setTimeout(() => noti.remove(), 5000);
    }

    function flushNotifications() {
        if (!document.body) return;
        while (__pendingNotifications.length) showNotification(__pendingNotifications.shift());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', flushNotifications, { once: true });
    } else {
        flushNotifications();
    }

    function rhEscapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    }

    function rhGetResources() {
        const v = GM_getValue(RESOURCES_KEY, []);
        const list = Array.isArray(v) ? v : [];

        const normalized = [];
        list.forEach(item => {
            if (typeof item === 'string') {
                const name = item.trim();
                if (name) normalized.push({ name, url: '', addedAt: '' });
                return;
            }

            if (item && typeof item === 'object') {
                const name = typeof item.name === 'string' ? item.name.trim() : '';
                if (!name) return;
                const url = typeof item.url === 'string' ? item.url.trim() : '';
                const addedAt = typeof item.addedAt === 'string' ? item.addedAt : '';
                normalized.push({ name, url, addedAt });
            }
        });

        return normalized;
    }

    function rhSaveResources(list) {
        const src = Array.isArray(list) ? list : [];
        const out = [];
        src.forEach(item => {
            if (!item) return;
            if (typeof item === 'string') {
                const name = item.trim();
                if (name) out.push({ name, url: '', addedAt: '' });
                return;
            }

            if (item && typeof item === 'object') {
                const name = typeof item.name === 'string' ? item.name.trim() : '';
                if (!name) return;
                const url = typeof item.url === 'string' ? item.url.trim() : '';
                const addedAt = typeof item.addedAt === 'string' ? item.addedAt : '';
                out.push({ name, url, addedAt });
            }
        });

        GM_setValue(RESOURCES_KEY, out);
    }

    function rhIsFileField(input) {
        try {
            if (!input || typeof input !== 'object') return false;
            const desc = typeof input.description === 'string' ? input.description : '';
            const nodeName = typeof input.nodeName === 'string' ? input.nodeName : '';
            const fieldName = typeof input.fieldName === 'string' ? input.fieldName : '';
            if (desc.includes('上传')) return true;
            if (nodeName.toLowerCase().includes('load')) return true;
            return ['video', 'image', 'file', 'filename'].includes(fieldName.toLowerCase());
        } catch (e) {
            return false;
        }
    }

    let rhUiStylesInstalled = false;
    function rhEnsureUiStyles() {
        if (rhUiStylesInstalled) return;
        rhUiStylesInstalled = true;

        GM_addStyle(`
            #runninghub-panel {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: white;
                border: 2px solid #1976d2;
                border-radius: 10px;
                padding: 16px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.4);
                z-index: 9999;
                font-family: Arial, sans-serif;
                font-size: 14px;
                min-width: 220px;
                color: #000;
                background: linear-gradient(to bottom, #ffffff, #f5f5f5);
            }
            #runninghub-panel button {
                width: 100%;
                padding: 10px;
                margin: 6px 0;
                background: #1976d2;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: bold;
            }
            #runninghub-panel button:hover {background:#1565c0;transform:scale(1.02);}
            #runninghub-clear-templates, #runninghub-clear-resources {background:#d32f2f;}
            #runninghub-clear-templates:hover, #runninghub-clear-resources:hover {background:#b71c1c;}

            .rh-modal-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.6);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .rh-modal {
                background: #fff;
                border-radius: 10px;
                width: min(980px, 95vw);
                max-height: 90vh;
                overflow: auto;
                padding: 16px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.35);
                color: #000;
            }
            .rh-modal h3 { margin: 0; font-size: 16px; }
            .rh-modal .rh-topbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding-bottom: 10px;
                border-bottom: 1px solid #eee;
                margin-bottom: 12px;
            }
            .rh-modal .rh-close {
                border: 0;
                background: #ff4444;
                color: #fff;
                border-radius: 8px;
                padding: 8px 10px;
                cursor: pointer;
                font-weight: 700;
            }
            .rh-tabs {
                display: flex;
                gap: 8px;
                margin: 10px 0 12px;
                border-bottom: 1px solid #ddd;
                padding-bottom: 10px;
            }
            .rh-tab {
                border: 0;
                background: #f0f0f0;
                color: #333;
                padding: 8px 10px;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 700;
            }
            .rh-tab.rh-active { background: #1976d2; color: #fff; }
            .rh-muted { color: #444; font-size: 12px; line-height: 1.5; }
            .rh-card {
                border: 1px solid #e0e0e0;
                border-radius: 10px;
                padding: 12px;
                margin: 10px 0;
                background: linear-gradient(to bottom, #ffffff, #fafafa);
            }
            .rh-row {
                display: flex;
                gap: 10px;
                align-items: center;
                flex-wrap: wrap;
            }
            .rh-grow { flex: 1; min-width: 220px; }
            .rh-input {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid #ccc;
                border-radius: 8px;
                padding: 8px 10px;
                font-size: 13px;
                background: #fff;
                color: #000;
            }
            .rh-input::placeholder { color: #777; }
            .rh-btn {
                border: 0;
                border-radius: 8px;
                padding: 8px 10px;
                cursor: pointer;
                font-weight: 700;
                color: #fff;
            }
            .rh-modal a.rh-btn { text-decoration: none; display: inline-block; }
            .rh-btn-primary { background: #1976d2; color: #fff; }
            .rh-btn-good { background: #00aa00; color: #fff; }
            .rh-btn-danger { background: #ff4444; color: #fff; }
            .rh-table { width: 100%; border-collapse: collapse; }
            .rh-table th, .rh-table td { border-top: 1px solid #eee; padding: 8px; text-align: left; vertical-align: top; }
            .rh-table th { background: #f6f6f6; font-size: 12px; color: #000; }
            .rh-small { font-size: 12px; color: #333; }
        `);
    }

    function rhOpenResourcePreview(resource) {
        rhEnsureUiStyles();
        if (!document.body) return;

        const name = resource && typeof resource.name === 'string' ? resource.name : '';
        const url = resource && typeof resource.url === 'string' ? resource.url : '';
        if (!url) {
            alert('该资源没有可预览 URL。');
            return;
        }

        function guessKind(n, u) {
            const s = String(n || u || '').toLowerCase();
            if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/.test(s)) return 'image';
            if (/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(s)) return 'video';
            return 'other';
        }

        const kind = guessKind(name, url);
        const overlay = createModal();
        overlay.className = 'rh-modal-overlay';
        overlay.innerHTML = `
            <div class="rh-modal" role="dialog" aria-modal="true">
                <div class="rh-topbar">
                    <h3>资源预览</h3>
                    <button class="rh-close" id="rh-close">关闭</button>
                </div>
                <div class="rh-small" style="word-break:break-all;margin-bottom:10px;">${rhEscapeHtml(name || '(unnamed)')}</div>
                <div class="rh-row" style="justify-content:flex-end;margin-bottom:10px;">
                    <a class="rh-btn rh-btn-primary" href="${rhEscapeHtml(url)}" target="_blank" rel="noreferrer">新窗口打开</a>
                    <button class="rh-btn rh-btn-primary" id="rh-copy-url" type="button">复制URL</button>
                </div>
                <div id="rh-preview"></div>
                <div class="rh-muted" style="margin-top:10px;">如果预览空白，可能是该 URL 需要登录态或被跨域限制。你仍可点“新窗口打开”。</div>
            </div>
        `;
        document.body.appendChild(overlay);

        function closePreview() {
            try {
                if (overlay.__rhClosed) return;
                overlay.__rhClosed = true;
            } catch (e) {}

            // Stop media explicitly; some browsers may continue audio briefly if the DOM is removed while hidden/playing.
            try {
                overlay.querySelectorAll('video, audio').forEach(m => {
                    try { m.pause(); } catch (e) {}
                    try { m.currentTime = 0; } catch (e) {}
                    try { m.removeAttribute('src'); } catch (e) {}
                    try { m.src = ''; } catch (e) {}
                    try { m.load(); } catch (e) {}
                });
            } catch (e) {}

            try { overlay.remove(); } catch (e) {}
        }

        overlay.querySelector('#rh-close').onclick = closePreview;
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closePreview();
        });

        overlay.querySelector('#rh-copy-url').onclick = async () => {
            try {
                await navigator.clipboard.writeText(url);
                showNotification('URL 已复制到剪贴板');
            } catch (e) {
                showNotification('复制失败，请手动复制');
            }
        };

        const preview = overlay.querySelector('#rh-preview');
        if (kind === 'image') {
            const img = document.createElement('img');
            img.src = url;
            img.alt = name;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '65vh';
            img.style.display = 'block';
            img.style.margin = '0 auto';
            preview.appendChild(img);
        } else if (kind === 'video') {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.style.width = '100%';
            video.style.maxHeight = '65vh';
            preview.appendChild(video);
        } else {
            const box = document.createElement('div');
            box.className = 'rh-card rh-muted';
            box.textContent = '该资源类型暂不支持内嵌预览。请使用“新窗口打开”。';
            preview.appendChild(box);
        }
    }

    function rhDownloadText(filename, content) {
        try {
            const blob = new Blob([String(content || '')], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = String(filename || 'runninghub-export.json');
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('下载失败，请手动复制保存。');
        }
    }

    function rhOpenExportModal(titleText, jsonText, filename) {
        rhEnsureUiStyles();
        if (!document.body) return;

        const overlay = createModal();
        overlay.className = 'rh-modal-overlay';
        overlay.innerHTML = `
            <div class="rh-modal" role="dialog" aria-modal="true">
                <div class="rh-topbar">
                    <h3>${rhEscapeHtml(titleText || '导出')}</h3>
                    <button class="rh-close" id="rh-close">关闭</button>
                </div>
                <div class="rh-row" style="justify-content:flex-end;margin-bottom:10px;">
                    <button class="rh-btn rh-btn-primary" id="rh-copy" type="button">复制</button>
                    <button class="rh-btn rh-btn-good" id="rh-download" type="button">下载</button>
                </div>
                <textarea class="rh-input" id="rh-text" spellcheck="false" style="min-height:520px;font-family:Consolas,ui-monospace,monospace;font-size:12px;"></textarea>
                <div class="rh-muted" style="margin-top:10px;">提示：导出的 JSON 可能包含敏感信息（例如工作流参数）。请勿发给不可信的人。</div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelector('#rh-close').onclick = close;
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        const ta = overlay.querySelector('#rh-text');
        ta.value = typeof jsonText === 'string' ? jsonText : '';
        ta.focus();
        ta.select();

        overlay.querySelector('#rh-copy').onclick = async () => {
            try {
                await navigator.clipboard.writeText(ta.value);
                showNotification('已复制到剪贴板');
            } catch (e) {
                showNotification('复制失败，请手动 Ctrl+C');
            }
        };

        overlay.querySelector('#rh-download').onclick = () => {
            const text = ta.value || '';
            if (!String(text).trim()) {
                showNotification('内容为空，无法下载');
                return;
            }
            rhDownloadText(filename, text);
            showNotification('已触发下载');
        };
    }

    function rhExportTemplatesText() {
        // Export as "create payload" list: [{webappId,inputs,clientId,...}, ...]
        const templates = rhGetTemplates();
        const payloads = [];
        templates.forEach(t => {
            const req = t && t.request && typeof t.request === 'object' ? t.request : null;
            const body = req && typeof req.body === 'string' ? req.body : '';
            const payload = body ? rhTryParseJson(body) : null;
            if (payload && typeof payload === 'object') payloads.push(payload);
        });
        return JSON.stringify(payloads, null, 2);
    }

    function rhExportSingleTemplateText(tpl) {
        const t = tpl && typeof tpl === 'object' ? tpl : null;
        const req = t && t.request && typeof t.request === 'object' ? t.request : null;
        const body = req && typeof req.body === 'string' ? req.body : '';
        const payload = body ? rhTryParseJson(body) : null;
        return payload ? JSON.stringify(payload, null, 2) : '';
    }

    function openManagerModal(initialTab) {
        rhEnsureUiStyles();
        if (!document.body) return;

        const overlay = createModal();
        overlay.className = 'rh-modal-overlay';
        overlay.innerHTML = `
            <div class="rh-modal" role="dialog" aria-modal="true">
                <div class="rh-topbar">
                    <h3>RunningHub 管理</h3>
                    <button class="rh-close" id="rh-close">关闭</button>
                </div>
                <div class="rh-muted">模板库保存的是 create 请求模板（webappId/referrer），token 不会被保存；资源库会记录你上传的文件名（hash）。</div>
                <div class="rh-tabs">
                    <button class="rh-tab" id="rh-tab-templates">模板库</button>
                    <button class="rh-tab" id="rh-tab-resources">资源库</button>
                </div>
                <div id="rh-pane-templates"></div>
                <div id="rh-pane-resources" style="display:none;"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#rh-close').onclick = () => overlay.remove();
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.remove();
        });

        const tabTemplates = overlay.querySelector('#rh-tab-templates');
        const tabResources = overlay.querySelector('#rh-tab-resources');
        const paneTemplates = overlay.querySelector('#rh-pane-templates');
        const paneResources = overlay.querySelector('#rh-pane-resources');

        function setTab(tab) {
            const isTemplates = tab === 'templates';
            tabTemplates.classList.toggle('rh-active', isTemplates);
            tabResources.classList.toggle('rh-active', !isTemplates);
            paneTemplates.style.display = isTemplates ? 'block' : 'none';
            paneResources.style.display = isTemplates ? 'none' : 'block';
            if (isTemplates) renderTemplates();
            else renderResources();
        }

        function renderTemplates() {
            paneTemplates.innerHTML = '';
            const templates = rhGetTemplates();

            const tools = document.createElement('div');
            tools.className = 'rh-row';
            tools.style.justifyContent = 'flex-end';
            tools.style.marginBottom = '10px';
            tools.style.gap = '10px';

            const exportBtn = document.createElement('button');
            exportBtn.className = 'rh-btn rh-btn-primary';
            exportBtn.textContent = '导出模板库';
            exportBtn.onclick = () => {
                const templates = rhGetTemplates();
                let skipped = 0;
                templates.forEach(t => {
                    const req = t && t.request && typeof t.request === 'object' ? t.request : null;
                    const body = req && typeof req.body === 'string' ? req.body : '';
                    const payload = body ? rhTryParseJson(body) : null;
                    if (!payload || typeof payload !== 'object') skipped += 1;
                });

                const text = rhExportTemplatesText();
                const filename = `runninghub-templates-${new Date().toISOString().slice(0, 10)}.json`;
                rhOpenExportModal('导出模板库（create payload 列表）', text, filename);
                if (skipped) showNotification(`已导出 payload；跳过 ${skipped} 条（body 不是 JSON）`);
            };

            const clearBtn = document.createElement('button');
            clearBtn.className = 'rh-btn rh-btn-danger';
            clearBtn.textContent = '清除模板库';
            clearBtn.onclick = () => {
                const ok = confirm('确认清除模板库？（不会影响 RunningHub 账号本身，仅清除本脚本保存的模板）');
                if (!ok) return;
                rhSaveTemplates([]);
                rhSetLastTemplateId('');
                GM_setValue(LEGACY_TEMPLATE_KEY, '');
                renderTemplates();
                showNotification('模板库已清空');
            };

            tools.appendChild(exportBtn);
            tools.appendChild(clearBtn);
            paneTemplates.appendChild(tools);

            if (templates.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'rh-card rh-muted';
                empty.textContent = '暂无模板：在页面正常“运行/提交”一次工作流后，会自动捕获 create 请求并写入模板库。';
                paneTemplates.appendChild(empty);
                return;
            }

            templates.forEach(t => {
                const card = document.createElement('div');
                card.className = 'rh-card';

                const row1 = document.createElement('div');
                row1.className = 'rh-row';

                const nameWrap = document.createElement('div');
                nameWrap.className = 'rh-grow';
                const nameInput = document.createElement('input');
                nameInput.className = 'rh-input';
                nameInput.type = 'text';
                nameInput.value = typeof t.name === 'string' ? t.name : '';
                nameInput.placeholder = '模板名称';
                nameWrap.appendChild(nameInput);

                const saveBtn = document.createElement('button');
                saveBtn.className = 'rh-btn rh-btn-primary';
                saveBtn.textContent = '保存名称';
                saveBtn.onclick = () => {
                    rhUpdateTemplateName(t.id, nameInput.value);
                    showNotification('名称已保存');
                };

                nameInput.addEventListener('keydown', e => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        saveBtn.click();
                    }
                });

                row1.appendChild(nameWrap);
                row1.appendChild(saveBtn);
                card.appendChild(row1);

                const meta = document.createElement('div');
                meta.className = 'rh-small';
                const appid = t.webappId ? String(t.webappId) : '';
                const referrer = t.referrer ? String(t.referrer) : '';
                const updatedAt = t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '';
                meta.innerHTML = `appid: <b>${rhEscapeHtml(appid || '-')}</b><br>referrer: ${rhEscapeHtml(referrer || '-')}${updatedAt ? `<br>更新: ${rhEscapeHtml(updatedAt)}` : ''}`;
                card.appendChild(meta);

                const row2 = document.createElement('div');
                row2.className = 'rh-row';
                row2.style.marginTop = '10px';

                const editBtn = document.createElement('button');
                editBtn.className = 'rh-btn rh-btn-good';
                editBtn.textContent = '编辑/重发';
                editBtn.onclick = () => {
                    overlay.remove();
                    openTemplateEditor(t.id);
                };

                const exportBtn = document.createElement('button');
                exportBtn.className = 'rh-btn rh-btn-primary';
                exportBtn.textContent = '导出';
                exportBtn.onclick = () => {
                    const text = rhExportSingleTemplateText(t);
                    if (!text) {
                        alert('该模板的 request.body 不是 JSON，无法导出为 create payload。');
                        return;
                    }
                    const safeId = (t && t.webappId) ? String(t.webappId) : String(t.id || 'template');
                    const filename = `runninghub-template-${safeId}.json`;
                    rhOpenExportModal(`导出模板 - ${t.name || t.id}`, text, filename);
                };

                const delBtn = document.createElement('button');
                delBtn.className = 'rh-btn rh-btn-danger';
                delBtn.textContent = '删除';
                delBtn.onclick = () => {
                    const ok = confirm(`确认删除模板 "${t.name || t.id}"？`);
                    if (!ok) return;
                    rhDeleteTemplate(t.id);
                    renderTemplates();
                };

                row2.appendChild(editBtn);
                row2.appendChild(exportBtn);
                row2.appendChild(delBtn);
                card.appendChild(row2);

                paneTemplates.appendChild(card);
            });
        }

        function renderResources() {
            paneResources.innerHTML = '';
            const resources = rhGetResources();

            const hint = document.createElement('div');
            hint.className = 'rh-muted';
            hint.textContent = '在页面正常上传视频/图片后会自动记录到这里。';
            paneResources.appendChild(hint);

            const tools = document.createElement('div');
            tools.className = 'rh-row';
            tools.style.justifyContent = 'flex-end';
            tools.style.margin = '10px 0';

            const clearBtn = document.createElement('button');
            clearBtn.className = 'rh-btn rh-btn-danger';
            clearBtn.textContent = '清除资源库';
            clearBtn.onclick = () => {
                const ok = confirm('确认清除资源库？（不会删除你已上传的文件，仅清除本脚本记录）');
                if (!ok) return;
                rhSaveResources([]);
                renderResources();
                showNotification('资源库已清空');
            };
            tools.appendChild(clearBtn);
            paneResources.appendChild(tools);

            if (resources.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'rh-card rh-muted';
                empty.textContent = '资源库为空。';
                paneResources.appendChild(empty);
                return;
            }

            const table = document.createElement('table');
            table.className = 'rh-table';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>文件名（hash）</th>
                        <th style="width:120px;">预览</th>
                        <th style="width:120px;">复制</th>
                        <th style="width:120px;">删除</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const tbody = table.querySelector('tbody');

            resources.forEach((res, idx) => {
                const name = res && typeof res.name === 'string' ? res.name : '';
                const url = res && typeof res.url === 'string' ? res.url : '';
                const addedAt = res && typeof res.addedAt === 'string' ? res.addedAt : '';
                const tr = document.createElement('tr');

                const tdName = document.createElement('td');
                tdName.style.wordBreak = 'break-all';
                tdName.innerHTML = `${idx + 1}. ${rhEscapeHtml(name)}${addedAt ? `<br><span class="rh-muted">添加: ${rhEscapeHtml(new Date(addedAt).toLocaleString())}</span>` : ''}`;

                const tdPreview = document.createElement('td');
                const previewBtn = document.createElement('button');
                previewBtn.className = 'rh-btn rh-btn-good';
                previewBtn.textContent = '预览';
                previewBtn.disabled = !url;
                if (!url) previewBtn.style.opacity = '0.6';
                previewBtn.onclick = () => {
                    if (!url) {
                        alert('该条资源没有可预览 URL（可能是旧记录）。重新上传一次文件后会记录可预览地址。');
                        return;
                    }
                    rhOpenResourcePreview({ name, url });
                };
                tdPreview.appendChild(previewBtn);

                const tdCopy = document.createElement('td');
                const copyBtn = document.createElement('button');
                copyBtn.className = 'rh-btn rh-btn-primary';
                copyBtn.textContent = '复制';
                copyBtn.onclick = async () => {
                    try {
                        await navigator.clipboard.writeText(String(name));
                        showNotification('已复制到剪贴板');
                    } catch (e) {
                        showNotification('复制失败，请手动复制');
                    }
                };
                tdCopy.appendChild(copyBtn);

                const tdDel = document.createElement('td');
                const delBtn = document.createElement('button');
                delBtn.className = 'rh-btn rh-btn-danger';
                delBtn.textContent = '删除';
                delBtn.onclick = () => {
                    const next = rhGetResources();
                    next.splice(idx, 1);
                    rhSaveResources(next);
                    renderResources();
                };
                tdDel.appendChild(delBtn);

                tr.appendChild(tdName);
                tr.appendChild(tdPreview);
                tr.appendChild(tdCopy);
                tr.appendChild(tdDel);
                tbody.appendChild(tr);
            });

            paneResources.appendChild(table);
        }

        tabTemplates.onclick = () => setTab('templates');
        tabResources.onclick = () => setTab('resources');
        setTab(initialTab === 'resources' ? 'resources' : 'templates');
    }

    function rhFindFixedAncestor(el) {
        let cur = el;
        while (cur && cur !== document.documentElement) {
            try {
                const cs = window.getComputedStyle(cur);
                if (cs && cs.position === 'fixed') return cur;
            } catch (e) {}
            cur = cur.parentElement;
        }
        return null;
    }

    function rhAdjustPanelAvoidOverlap(panelEl) {
        try {
            if (!panelEl || !document.body) return;
            const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
            const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
            if (!vw || !vh) return;

            const baseRight = 20;
            const baseBottom = 20;
            const gap = 12;

            panelEl.style.right = `${baseRight}px`;
            panelEl.style.bottom = `${baseBottom}px`;

            const points = [
                [vw - 5, vh - 5],
                [vw - 5, vh - 50],
                [vw - 50, vh - 5]
            ];

            let desiredRight = baseRight;
            points.forEach(([x, y]) => {
                const els = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
                els.forEach(rawEl => {
                    if (!rawEl) return;
                    if (panelEl.contains(rawEl)) return;
                    const fixedEl = rhFindFixedAncestor(rawEl);
                    if (!fixedEl || panelEl.contains(fixedEl)) return;

                    const rect = fixedEl.getBoundingClientRect();
                    if (!rect || rect.width < 40 || rect.height < 20) return;
                    // Only consider elements that are likely "corner widgets".
                    if (rect.right < vw - 2 || rect.bottom < vh - 2) return;

                    const rightOffset = Math.max(0, vw - rect.right);
                    const needed = rightOffset + rect.width + gap;
                    if (needed > desiredRight) desiredRight = needed;
                });
            });

            if (desiredRight !== baseRight) panelEl.style.right = `${desiredRight}px`;
        } catch (e) {
            // ignore
        }
    }

    function openTemplateEditor(templateId) {
        rhEnsureUiStyles();
        if (!document.body) return;

        const id = templateId || rhGetLastTemplateId() || (rhGetTemplates()[0] ? rhGetTemplates()[0].id : '');
        const template = rhFindTemplateById(id);
        if (!template) {
            alert('尚未捕获模板：请先正常提交一次任务（create 请求）');
            return;
        }

        const resources = rhGetResources().map(r => r && r.name).filter(Boolean);
        const req = template.request && typeof template.request === 'object' ? template.request : {};
        const bodyText = typeof req.body === 'string' ? req.body : '';
        const bodyObj = bodyText ? rhTryParseJson(bodyText) : null;

        const overlay = createModal();
        overlay.className = 'rh-modal-overlay';
        overlay.innerHTML = `
            <div class="rh-modal" role="dialog" aria-modal="true">
                <div class="rh-topbar">
                    <h3>编辑模板并重发</h3>
                    <button class="rh-close" id="rh-close">关闭</button>
                </div>
                <div class="rh-row" style="margin-bottom:10px;">
                    <div class="rh-grow">
                        <div class="rh-small" style="margin-bottom:6px;">模板名称（可自定义）</div>
                        <input class="rh-input" id="rh-name" type="text" value="${rhEscapeHtml(template.name || '')}" />
                    </div>
                    <div class="rh-grow">
                        <div class="rh-small" style="margin-bottom:6px;">Authorization Token（不会保存）</div>
                        <div class="rh-row">
                            <div class="rh-grow">
                                <input class="rh-input" id="rh-token" type="text" value="" placeholder="Bearer 后面的 token（可留空，尝试仅靠 Cookie）" />
                            </div>
                            <button class="rh-btn rh-btn-primary" id="rh-use-captured" type="button">用捕获Token</button>
                            <button class="rh-btn rh-btn-danger" id="rh-clear-token" type="button">清空</button>
                        </div>
                    </div>
                </div>
                <div class="rh-muted" id="rh-meta"></div>
                <div id="rh-body-area" style="margin-top:12px;"></div>
                <div class="rh-row" style="justify-content:flex-end;margin-top:12px;">
                    <button class="rh-btn rh-btn-primary" id="rh-save">保存模板</button>
                    <button class="rh-btn rh-btn-good" id="rh-send">发送请求</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#rh-close').onclick = () => overlay.remove();
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.remove();
        });

        overlay.querySelector('#rh-use-captured').onclick = () => {
            const input = overlay.querySelector('#rh-token');
            if (!input) return;
            input.value = String(lastCapturedToken || '');
            input.focus();
        };

        overlay.querySelector('#rh-clear-token').onclick = () => {
            const input = overlay.querySelector('#rh-token');
            if (!input) return;
            input.value = '';
            input.focus();
        };

        const metaEl = overlay.querySelector('#rh-meta');
        const metaAppid = template.webappId ? String(template.webappId) : '';
        const metaRef = template.referrer ? String(template.referrer) : '';
        metaEl.textContent = `appid: ${metaAppid || '-'} | referrer: ${metaRef || '-'}`;

        const bodyArea = overlay.querySelector('#rh-body-area');

        function renderBodyEditor() {
            bodyArea.innerHTML = '';

            if (!bodyObj || !bodyObj.inputs || !Array.isArray(bodyObj.inputs)) {
                const warn = document.createElement('div');
                warn.className = 'rh-card rh-muted';
                warn.textContent = '模板 body 不是标准 JSON（或缺少 inputs 数组）。你仍然可以直接编辑原始 body 然后发送。';
                bodyArea.appendChild(warn);

                const ta = document.createElement('textarea');
                ta.id = 'rh-raw-body';
                ta.spellcheck = false;
                ta.className = 'rh-input';
                ta.style.minHeight = '320px';
                ta.style.fontFamily = 'Consolas, monospace';
                ta.value = bodyText || '';
                bodyArea.appendChild(ta);
                return;
            }

            const table = document.createElement('table');
            table.className = 'rh-table';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th style="width:260px;">节点</th>
                        <th>fieldValue</th>
                        <th style="width:260px;">描述</th>
                        <th style="width:220px;">资源库替换</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const tbody = table.querySelector('tbody');

            bodyObj.inputs.forEach((input, idx) => {
                const tr = document.createElement('tr');

                const tdNode = document.createElement('td');
                tdNode.innerHTML = `${rhEscapeHtml(input.nodeId)} - ${rhEscapeHtml(input.nodeName)}<br><span class="rh-muted">${rhEscapeHtml(input.fieldName)}</span>`;

                const tdVal = document.createElement('td');
                const valInput = document.createElement('input');
                valInput.type = 'text';
                valInput.className = 'rh-input';
                const fv = input.fieldValue;
                const kind = (fv && typeof fv === 'object') ? 'json' : typeof fv;
                valInput.dataset.idx = String(idx);
                valInput.dataset.kind = kind;
                valInput.value = (fv && typeof fv === 'object') ? JSON.stringify(fv) : String(fv ?? '');
                tdVal.appendChild(valInput);

                const tdDesc = document.createElement('td');
                tdDesc.className = 'rh-muted';
                tdDesc.textContent = typeof input.description === 'string' ? input.description : '';

                const tdRes = document.createElement('td');
                if (rhIsFileField(input)) {
                    if (resources.length === 0) {
                        tdRes.className = 'rh-muted';
                        tdRes.textContent = '资源库为空';
                    } else {
                        const sel = document.createElement('select');
                        sel.className = 'rh-input';
                        const opt0 = document.createElement('option');
                        opt0.value = '';
                        opt0.textContent = '不替换';
                        sel.appendChild(opt0);
                        resources.forEach(name => {
                            const opt = document.createElement('option');
                            opt.value = name;
                            opt.textContent = name.length > 60 ? `${name.slice(0, 60)}...` : name;
                            sel.appendChild(opt);
                        });
                        sel.addEventListener('change', () => {
                            const v = sel.value;
                            if (!v) return;
                            valInput.value = v;
                        });
                        tdRes.appendChild(sel);
                    }
                } else {
                    tdRes.className = 'rh-muted';
                    tdRes.textContent = '-';
                }

                tr.appendChild(tdNode);
                tr.appendChild(tdVal);
                tr.appendChild(tdDesc);
                tr.appendChild(tdRes);
                tbody.appendChild(tr);
            });

            bodyArea.appendChild(table);
        }

        renderBodyEditor();

        function collectNextBodyText() {
            if (!bodyObj || !bodyObj.inputs || !Array.isArray(bodyObj.inputs)) {
                const raw = overlay.querySelector('#rh-raw-body');
                const value = raw ? String(raw.value || '') : '';
                return { ok: !!value.trim(), bodyText: value };
            }

            const inputs = overlay.querySelectorAll('input[data-idx]');
            inputs.forEach(el => {
                const idx = Number(el.dataset.idx);
                if (!Number.isFinite(idx) || !bodyObj.inputs[idx]) return;

                const kind = el.dataset.kind || 'string';
                const raw = String(el.value ?? '');

                if (kind === 'number') {
                    const n = Number(raw);
                    if (Number.isNaN(n)) throw new Error(`第 ${idx + 1} 行期望数字`);
                    bodyObj.inputs[idx].fieldValue = n;
                    return;
                }
                if (kind === 'boolean') {
                    const low = raw.trim().toLowerCase();
                    if (low !== 'true' && low !== 'false') throw new Error(`第 ${idx + 1} 行期望 true/false`);
                    bodyObj.inputs[idx].fieldValue = low === 'true';
                    return;
                }
                if (kind === 'json') {
                    const parsed = rhTryParseJson(raw);
                    if (!parsed || typeof parsed !== 'object') throw new Error(`第 ${idx + 1} 行 JSON 解析失败`);
                    bodyObj.inputs[idx].fieldValue = parsed;
                    return;
                }

                bodyObj.inputs[idx].fieldValue = raw;
            });

            if (template.webappId) bodyObj.webappId = template.webappId;
            return { ok: true, bodyText: JSON.stringify(bodyObj) };
        }

        function saveTemplateOnly() {
            const nextName = String((overlay.querySelector('#rh-name') || {}).value || '').trim();
            try {
                const { ok, bodyText: nextBodyText } = collectNextBodyText();
                if (!ok) {
                    showNotification('body 为空，无法保存');
                    return false;
                }

                const next = {
                    ...template,
                    name: nextName || template.name,
                    updatedAt: new Date().toISOString(),
                    request: {
                        ...req,
                        body: nextBodyText,
                        referrer: template.referrer || req.referrer || ''
                    }
                };
                rhUpsertTemplate(next);
                showNotification('模板已保存（token 未保存）');
                return true;
            } catch (e) {
                alert(e && e.message ? e.message : '保存失败');
                return false;
            }
        }

        overlay.querySelector('#rh-save').onclick = () => {
            saveTemplateOnly();
        };

        overlay.querySelector('#rh-send').onclick = async () => {
            const ok = saveTemplateOnly();
            if (!ok) return;

            const token = String((overlay.querySelector('#rh-token') || {}).value || '').trim();

            const latest = rhFindTemplateById(id) || template;
            const latestReq = latest.request && typeof latest.request === 'object' ? latest.request : req;

            const headers = rhHeadersToPlain(latestReq.headers);
            if (token) headers.authorization = `Bearer ${token}`;
            if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';

            const url = latestReq.url || 'https://www.runninghub.ai/task/webapp/create';
            const referrer = latest.referrer || latestReq.referrer || '';

            try {
                const resp = await fetch(url, {
                    method: latestReq.method || 'POST',
                    headers,
                    body: latestReq.body || '',
                    credentials: latestReq.credentials || 'include',
                    mode: latestReq.mode || 'cors',
                    referrer: referrer || undefined
                });
                const data = await resp.clone().json().catch(() => resp.text());
                console.log('%c[RunningHub Replay] 请求返回', 'color:blue;font-weight:bold', { status: resp.status, data });
                showNotification(`请求已发送（HTTP ${resp.status}）`);
            } catch (e) {
                console.error(e);
                showNotification('发送失败（请检查 token 或网络）');
            }
        };
    }

    // 确保 body 存在后再添加面板（防止 SPA 页面加载时机问题）
    function addPanel() {
        if (document.body) {
            rhEnsureUiStyles();
            if (document.getElementById('runninghub-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'runninghub-panel';
            panel.innerHTML = `
                <div style="font-weight:bold;margin-bottom:8px;font-size:15px;">RunningHub 工具</div>
                <button id="runninghub-open-manager">RunningHub助手</button>
            `;
            document.body.appendChild(panel);
            console.log('%c[RunningHub 工具] 控制面板已添加至右下角', 'color:blue;font-weight:bold;font-size:14px;');

            // 绑定事件
            document.getElementById('runninghub-open-manager').addEventListener('click', () => openManagerModal('templates'));

            // Try to avoid overlapping other bottom-right widgets/plugins.
            rhAdjustPanelAvoidOverlap(panel);
            setTimeout(() => rhAdjustPanelAvoidOverlap(panel), 800);
            window.addEventListener('resize', () => rhAdjustPanelAvoidOverlap(panel));
        } else {
            setTimeout(addPanel, 500); // 如果 body 未就绪，稍后重试
        }
    }

    addPanel();

    // 其余函数保持不变（openTemplateEditor、openLibraryModal、createModal 等）
    // 为节省篇幅，这里省略相同部分，但实际使用时请完整复制上一版的所有函数代码
    // （openTemplateEditor、openLibraryModal、createModal、以及它们内部的逻辑完全相同）

    // 请将上一版脚本中从 function openTemplateEditor() 开始到结束的所有代码复制到这里
    // （包括 openTemplateEditor、openLibraryModal、createModal）

    // 【重要】下面粘贴上一版的所有函数代码（从 function openTemplateEditor() 开始到末尾）

    // Legacy UI kept for reference; not used by current panel/manager.
    function openTemplateEditorLegacy() {
        openTemplateEditor();
        return;

        const raw = GM_getValue(LEGACY_TEMPLATE_KEY);
        if (!raw) {
            alert('尚未捕获 create 模板，请先正常提交一次任务。');
            return;
        }

        const template = JSON.parse(raw);
        const bodyObj = JSON.parse(template.body);
        const currentToken = template.headers.authorization?.split('Bearer ')[1] || '';
        const resources = GM_getValue(RESOURCES_KEY, []);

        let inputsHTML = '';
        bodyObj.inputs.forEach((input, idx) => {
            const displayValue = typeof input.fieldValue === 'object' ? JSON.stringify(input.fieldValue) : input.fieldValue;

            const isFileField = (input.description && input.description.includes('上传')) ||
                                input.nodeName?.includes('Load') ||
                                ['video', 'image', 'file', 'filename'].includes(input.fieldName);

            let resourceSelect = '';
            if (isFileField && resources.length > 0) {
                resourceSelect = `
                    <td style="padding:4px;">
                        <select data-idx="${idx}" style="width:100%;padding:4px;font-size:12px;">
                            <option value="">不替换</option>
                            ${resources.map(name => `<option value="${name}">${name.substring(0, 40)}...</option>`).join('')}
                        </select>
                    </td>`;
            } else if (isFileField) {
                resourceSelect = '<td style="padding:4px;color:#999;font-size:12px;">资源库为空</td>';
            } else {
                resourceSelect = '';
            }

            inputsHTML += `
                <tr>
                    <td style="padding:4px 8px;white-space:nowrap;">${input.nodeId} - ${input.nodeName}<br><small>${input.fieldName}</small></td>
                    <td style="padding:4px;"><input type="text" data-idx="${idx}" value="${displayValue}" style="width:100%;padding:4px;"></td>
                    <td style="padding:4px;font-size:12px;color:#555;">${input.description || ''}</td>
                    ${resourceSelect}
                </tr>`;
        });

        const modal = createModal();
        modal.innerHTML = `
            <div style="background:white;border-radius:8px;padding:20px;max-width:95%;max-height:90%;overflow:auto;">
                <h3 style="margin-top:0;">编辑 Create 请求模板</h3>
                <div style="margin-bottom:12px;">
                    <label>Authorization Token:</label><br>
                    <input type="text" id="modal-token" value="${currentToken}" style="width:100%;padding:6px;">
                </div>
                <table style="width:100%;border-collapse:collapse;">
                    <thead><tr>
                        <th style="text-align:left;padding:8px;background:#f0f0f0;">节点</th>
                        <th style="text-align:left;padding:8px;background:#f0f0f0;">fieldValue</th>
                        <th style="text-align:left;padding:8px;background:#f0f0f0;">描述</th>
                        <th style="text-align:left;padding:8px;background:#f0f0f0;">资源库替换</th>
                    </tr></thead>
                    <tbody>${inputsHTML}</tbody>
                </table>
                <div style="margin-top:16px;text-align:right;">
                    <button id="modal-cancel">取消</button>
                    <button id="modal-send" style="background:#1976d2;color:white;margin-left:8px;padding:8px 16px;">发送请求</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('select[data-idx]').forEach(sel => {
            sel.addEventListener('change', () => {
                const idx = sel.dataset.idx;
                const selected = sel.value;
                if (selected) {
                    const input = modal.querySelector(`input[data-idx="${idx}"]`);
                    if (input) input.value = selected;
                }
            });
        });

        modal.querySelector('#modal-cancel').onclick = () => modal.remove();

        modal.querySelector('#modal-send').onclick = () => {
            const newToken = modal.querySelector('#modal-token').value.trim();
            template.headers.authorization = 'Bearer ' + newToken;

            modal.querySelectorAll('input[data-idx]').forEach(inp => {
                const idx = inp.dataset.idx;
                let val = inp.value.trim();
                if (val === 'true') val = true;
                else if (val === 'false') val = false;
                else if (!isNaN(val) && val !== '') val = Number(val);
                bodyObj.inputs[idx].fieldValue = val;
            });

            template.body = JSON.stringify(bodyObj);

            fetch(template.url, {
                method: template.method,
                headers: template.headers,
                body: template.body,
                credentials: template.credentials,
                mode: template.mode
            })
            .then(r => r.json().catch(() => r.text()))
            .then(data => {
                console.log('%c[RunningHub Replay] 请求发送成功', 'color:blue;font-weight:bold', data);
                showNotification('请求已发送');
            })
            .catch(err => {
                console.error(err);
                showNotification('发送失败');
            });

            modal.remove();
        };
    }

    function openLibraryModalLegacy() {
        openManagerModal('resources');
        return;

        const resources = GM_getValue(RESOURCES_KEY, []);

        let listHTML = '';
        if (resources.length === 0) {
            listHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:#999;">资源库为空（正常上传文件后会自动记录）</td></tr>';
        } else {
            resources.forEach((name, i) => {
                listHTML += `
                    <tr>
                        <td style="padding:8px;word-break:break-all;font-size:12px;">${i+1}. ${name}</td>
                        <td style="padding:8px;"><button data-name="${name}" class="copy-btn" style="padding:4px 8px;font-size:12px;">复制</button></td>
                        <td style="padding:8px;"><button data-idx="${i}" class="del-btn" style="padding:4px 8px;font-size:12px;background:#d32f2f;">删除</button></td>
                    </tr>`;
            });
        }

        const modal = createModal();
        modal.innerHTML = `
            <div style="background:white;border-radius:8px;padding:20px;max-width:90%;max-height:90%;overflow:auto;">
                <h3 style="margin-top:0;">资源库（已上传文件）</h3>
                <p style="color:#666;font-size:13px;margin-bottom:16px;">在页面正常上传视频/图片后会自动记录到这里</p>
                <table style="width:100%;border-collapse:collapse;">
                    <thead><tr style="background:#f0f0f0;">
                        <th style="text-align:left;padding:8px;">文件名（hash）</th>
                        <th style="width:80px;padding:8px;">操作</th>
                        <th style="width:80px;padding:8px;">删除</th>
                    </tr></thead>
                    <tbody>${listHTML}</tbody>
                </table>
                <div style="margin-top:16px;text-align:right;">
                    <button id="modal-close">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.name);
                showNotification('已复制: ' + btn.dataset.name.substring(0, 20) + '...');
            });
        });

        modal.querySelectorAll('.del-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = btn.dataset.idx;
                resources.splice(idx, 1);
                GM_setValue(RESOURCES_KEY, resources);
                modal.remove();
                openLibraryModalLegacy();
            });
        });

        modal.querySelector('#modal-close').onclick = () => modal.remove();
    }

    function createModal() {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;
            display:flex;align-items:center;justify-content:center;
        `;
        return modal;
    }
})();
