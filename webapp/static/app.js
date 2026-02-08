/* global fetch */

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  });
  children.forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return n;
}

function setStatus(msg) { $('#status').textContent = msg || ''; }
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return String(iso || ''); }
}
function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }
function pretty(obj) { return JSON.stringify(obj, null, 2); }

const state = {
  templates: [],
  profiles: [],
  resources: [],
  jobs: [],
  downloads: [],
  settings: { jobTimeoutSec: 600, historyIntervalSec: 3.0, requestTimeoutSec: 25.0 },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function guessInputKind(input) {
  const fv = input ? input.fieldValue : undefined;
  if (typeof fv === 'boolean') return 'bool';
  if (typeof fv === 'number') return 'num';
  if (isObj(fv)) return 'json';

  const nodeName = String(input?.nodeName || '').toLowerCase();
  const fieldName = String(input?.fieldName || '').toLowerCase();
  const s = String(fv ?? '').trim().toLowerCase();

  // Heuristics for common RunningHub nodes.
  if ((nodeName.includes('boolean') || fieldName.includes('boolean')) && (s === 'true' || s === 'false')) return 'bool';
  if ((nodeName === 'int' || nodeName.includes('int') || nodeName.includes('float')) && s && !Number.isNaN(Number(s))) return 'num';
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) return 'json';
  return 'text';
}

function isFileField(input) {
  const desc = String(input?.description || '');
  const nodeName = String(input?.nodeName || '').toLowerCase();
  const fieldName = String(input?.fieldName || '').toLowerCase();
  if (desc.includes('上传')) return true;
  if (nodeName.includes('load')) return true;
  if (['video', 'image', 'file', 'filename'].includes(fieldName)) return true;
  return false;
}

function mountInputsTable(container, textarea, resources) {
  container.innerHTML = '';
  const payloadObj = safeJsonParse(textarea.value);
  if (!payloadObj || !isObj(payloadObj)) {
    container.appendChild(el('div', { class: 'card hint' }, ['payload 不是合法 JSON 对象，无法渲染 inputs 表格。']));
    return;
  }
  const inputs = payloadObj.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    container.appendChild(el('div', { class: 'card hint' }, ['payload.inputs 为空或不存在。']));
    return;
  }

  const resNames = Array.isArray(resources) ? resources.map(r => r && r.name).filter(Boolean) : [];
  const table = el('table', { class: 'table' }, []);
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['nodeId']),
      el('th', {}, ['nodeName']),
      el('th', {}, ['fieldName']),
      el('th', {}, ['description']),
      el('th', {}, ['fieldValue']),
      el('th', {}, ['资源库']),
    ])
  ]));
  const tb = el('tbody');

  function writeBack() {
    textarea.value = pretty(payloadObj);
  }

  inputs.forEach((inp, idx) => {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'mono' }, [String(inp?.nodeId ?? '')]));
    tr.appendChild(el('td', {}, [String(inp?.nodeName ?? '')]));
    tr.appendChild(el('td', { class: 'mono' }, [String(inp?.fieldName ?? '')]));
    tr.appendChild(el('td', { class: 'hint' }, [String(inp?.description ?? '')]));

    const kind = guessInputKind(inp);
    let editor;

    if (kind === 'bool') {
      const wrap = el('div', { class: 'row' }, []);
      const cb = el('input', { type: 'checkbox', style: 'width:18px;height:18px;' });
      const raw = inp?.fieldValue;
      cb.checked = (raw === true) || (String(raw ?? '').trim().toLowerCase() === 'true');
      cb.addEventListener('change', () => {
        payloadObj.inputs[idx].fieldValue = cb.checked;
        writeBack();
      });
      wrap.appendChild(cb);
      wrap.appendChild(el('span', { class: 'hint' }, [cb.checked ? 'true' : 'false']));
      editor = wrap;
    } else if (kind === 'num') {
      const v = inp?.fieldValue;
      const n = (typeof v === 'number') ? v : Number(String(v ?? '').trim());
      const input = el('input', { type: 'number', value: Number.isFinite(n) ? String(n) : '' });
      input.addEventListener('input', () => {
        const next = Number(input.value);
        if (!Number.isNaN(next)) payloadObj.inputs[idx].fieldValue = next;
        writeBack();
      });
      editor = input;
    } else if (kind === 'json') {
      const ta = el('textarea', { spellcheck: 'false', style: 'min-height:120px' }, [
        isObj(inp?.fieldValue) ? pretty(inp.fieldValue) : String(inp?.fieldValue ?? '')
      ]);
      ta.addEventListener('change', () => {
        const j = safeJsonParse(ta.value);
        if (j === null) { alert(`第 ${idx + 1} 行 fieldValue JSON 解析失败`); return; }
        payloadObj.inputs[idx].fieldValue = j;
        writeBack();
      });
      editor = ta;
    } else {
      const input = el('input', { type: 'text', value: String(inp?.fieldValue ?? '') });
      input.addEventListener('input', () => {
        payloadObj.inputs[idx].fieldValue = input.value;
        writeBack();
      });
      editor = input;
    }

    const td = el('td');
    td.appendChild(editor);
    tr.appendChild(td);

    const tdRes = el('td');
    if (isFileField(inp) && resNames.length) {
      const sel = el('select');
      sel.appendChild(el('option', { value: '' }, ['不替换']));
      resNames.forEach(n => sel.appendChild(el('option', { value: n }, [n])));
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        payloadObj.inputs[idx].fieldValue = sel.value;
        writeBack();
        // best-effort: update visible editor too
        if (editor && editor.tagName === 'INPUT') editor.value = sel.value;
      });
      tdRes.appendChild(sel);
    } else {
      tdRes.appendChild(el('span', { class: 'hint' }, ['-']));
    }
    tr.appendChild(tdRes);
    tb.appendChild(tr);
  });

  table.appendChild(tb);
  container.appendChild(table);
}

async function api(method, path, body) {
  const opt = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  const t = await r.text();
  const j = safeJsonParse(t);
  if (!r.ok) throw new Error((j && j.detail) ? j.detail : `HTTP ${r.status}: ${t}`);
  return j || {};
}

function showModal(title, node) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = '';
  body.appendChild(node);
  $('#modal').style.display = 'flex';
}

function pauseAllMedia() {
  try {
    document.querySelectorAll('video, audio').forEach(m => {
      try { m.pause(); } catch {}
    });
  } catch {}
}

function closeModal() {
  // Ensure media stops when modal is closed (otherwise audio may keep playing while hidden).
  try {
    const body = $('#modal-body');
    body.querySelectorAll('video, audio').forEach(m => {
      try { m.pause(); } catch {}
      try { m.currentTime = 0; } catch {}
      try { m.removeAttribute('src'); } catch {}
      try { m.src = ''; } catch {}
      try { m.load(); } catch {}
    });
    // Drop DOM to release resources.
    body.innerHTML = '';
  } catch {}

  $('#modal').style.display = 'none';
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });

function setView(name) {
  pauseAllMedia();
  document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  $(`#view-${name}`).style.display = 'block';
}

document.querySelectorAll('.navbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    setView(btn.dataset.view);
    render();
  });
});

async function refreshAll() {
  const [t, c, r, j, d, s] = await Promise.all([
    api('GET', '/api/templates'),
    api('GET', '/api/cookies'),
    api('GET', '/api/resources'),
    api('GET', '/api/jobs'),
    api('GET', '/api/downloads'),
    api('GET', '/api/settings'),
  ]);
  state.templates = t.templates || [];
  state.profiles = c.profiles || [];
  state.resources = r.resources || [];
  state.jobs = j.jobs || [];
  state.downloads = d.items || [];
  state.settings = s.settings || state.settings;
}

function renderTemplates() {
  const root = $('#view-templates');
  root.innerHTML = '';

  root.appendChild(el('div', { class: 'h1' }, ['模板管理']));
  root.appendChild(el('div', { class: 'hint' }, [
    '模板保存的是 create 的 payload（JSON 对象）。可以导入/导出。生成时可以临时修改 payload，不一定要改模板本身。'
  ]));

  const tools = el('div', { class: 'row', style: 'margin-top:10px;' }, [
    el('button', { class: 'btn good', onclick: () => openTemplateEditor(null) }, ['新建模板']),
    el('button', { class: 'btn', onclick: () => exportTemplates() }, ['导出模板']),
    el('button', { class: 'btn warn', onclick: () => importTemplates() }, ['导入模板']),
  ]);
  root.appendChild(tools);

  if (state.templates.length === 0) {
    root.appendChild(el('div', { class: 'card hint' }, ['暂无模板。']));
    return;
  }

  const table = el('table', { class: 'table', style: 'margin-top:12px;' }, []);
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['名称']),
      el('th', {}, ['webappId']),
      el('th', {}, ['更新']),
      el('th', {}, ['操作']),
    ])
  ]));
  const tb = el('tbody');

  state.templates.forEach(t => {
    const tr = el('tr');
    tr.appendChild(el('td', {}, [t.name || t.id]));
    tr.appendChild(el('td', { class: 'mono' }, [String(t.webappId || '')]));
    tr.appendChild(el('td', {}, [fmtTime(t.updatedAt)]));
    const ops = el('td', {}, [
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', onclick: () => openTemplateEditor(t) }, ['编辑']),
        el('button', { class: 'btn danger', onclick: () => deleteTemplate(t.id) }, ['删除']),
      ])
    ]);
    tr.appendChild(ops);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  root.appendChild(table);
}

function openTemplateEditor(tpl) {
  const isNew = !tpl;
  const init = tpl ? { ...tpl } : { name: '', webappId: '', payload: {} };

  const name = el('input', { value: init.name || '' });
  const webappId = el('input', { value: init.webappId || '' });
  const payload = el('textarea', { spellcheck: 'false' }, [pretty(init.payload || {})]);
  const inputsBox = el('div', { class: 'card', style: 'display:none' });

  const form = el('div', {}, [
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, ['名称']),
        name
      ]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, ['webappId（可选，会从 payload.webappId 自动推断）']),
        webappId
      ]),
    ]),
    el('div', { class: 'label', style: 'margin-top:10px;' }, ['payload（JSON）']),
    payload,
    el('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px;' }, [
      el('button', {
        class: 'btn',
        onclick: () => {
          inputsBox.style.display = 'block';
          mountInputsTable(inputsBox, payload, state.resources);
        }
      }, ['渲染 inputs 表格']),
      el('div', { class: 'hint' }, ['表格编辑会实时回写 JSON。'])
    ]),
    inputsBox,
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px;' }, [
      el('button', { class: 'btn ghost', onclick: closeModal }, ['取消']),
      el('button', {
        class: 'btn good',
        onclick: async () => {
          const p = safeJsonParse(payload.value);
          if (!p || typeof p !== 'object') { alert('payload 不是合法 JSON 对象'); return; }
          const body = { name: name.value.trim(), webappId: webappId.value.trim(), payload: p };
          if (isNew) await api('POST', '/api/templates', body);
          else await api('PUT', `/api/templates/${init.id}`, body);
          await refreshAll();
          closeModal();
          render();
        }
      }, ['保存']),
    ])
  ]);

  showModal(isNew ? '新建模板' : '编辑模板', form);
}

async function deleteTemplate(id) {
  if (!confirm('确认删除该模板？')) return;
  await api('DELETE', `/api/templates/${id}`);
  await refreshAll();
  render();
}

async function exportTemplates() {
  const data = await api('GET', '/api/templates/export');
  const text = pretty(data);
  showModal('导出模板', el('div', {}, [
    el('div', { class: 'hint' }, ['复制或保存为 JSON 文件。']),
    el('textarea', { spellcheck: 'false' }, [text])
  ]));
}

async function importTemplates() {
  const ta = el('textarea', { spellcheck: 'false', placeholder: '粘贴模板 JSON（{templates:[...]} 或 [...] 或 单个对象）' });
  const box = el('div', {}, [
    el('div', { class: 'hint' }, ['导入后会与现有模板合并（按 id 覆盖）。']),
    ta,
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px;' }, [
      el('button', { class: 'btn ghost', onclick: closeModal }, ['取消']),
      el('button', {
        class: 'btn warn',
        onclick: async () => {
          const j = safeJsonParse(ta.value);
          if (!j) { alert('JSON 解析失败'); return; }
          await api('POST', '/api/templates/import', j);
          await refreshAll();
          closeModal();
          render();
        }
      }, ['导入'])
    ])
  ]);
  showModal('导入模板', box);
}

function renderCookies() {
  const root = $('#view-cookies');
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'h1' }, ['Cookies 管理']));
  root.appendChild(el('div', { class: 'hint' }, [
    '支持导入 TokenMaster 的 cookies.txt（单条）或 multicookies.txt（多条）。本页面只做“选择与转发”，不会帮你登录。'
  ]));

  const tools = el('div', { class: 'row', style: 'margin-top:10px;' }, [
    el('button', { class: 'btn warn', onclick: () => importCookies() }, ['导入 cookies']),
    el('button', { class: 'btn', onclick: () => exportCookies() }, ['导出 cookies（multi）']),
  ]);
  root.appendChild(tools);

  if (state.profiles.length === 0) {
    root.appendChild(el('div', { class: 'card hint' }, ['暂无 cookies profile。']));
    return;
  }

  const table = el('table', { class: 'table', style: 'margin-top:12px;' }, []);
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['名称']),
      el('th', {}, ['host']),
      el('th', {}, ['积分(totalCoin)']),
      el('th', {}, ['操作']),
    ])
  ]));
  const tb = el('tbody');

  state.profiles.forEach(p => {
    const tr = el('tr');
    tr.appendChild(el('td', {}, [p.name || p.id]));
    tr.appendChild(el('td', { class: 'mono' }, [String(p.host || '')]));
    tr.appendChild(el('td', { class: 'mono' }, [String((p && p.totalCoin !== undefined && p.totalCoin !== null && String(p.totalCoin).trim()) ? p.totalCoin : '-')]));
    tr.appendChild(el('td', {}, [
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', onclick: () => previewCookie(p) }, ['查看']),
        el('button', { class: 'btn good', onclick: (e) => refreshUserInfo(p.id, e.currentTarget) }, ['刷新']),
        el('button', { class: 'btn danger', onclick: () => deleteCookie(p.id) }, ['删除']),
      ])
    ]));
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  root.appendChild(table);
}

async function refreshUserInfo(profileId, btn) {
  if (!profileId) return;
  const b = btn;
  try {
    if (b) { b.disabled = true; b.textContent = '刷新中...'; }
    setStatus('getUserInfo...');
    const r = await api('POST', '/api/getUserInfo', { profileId });
    await refreshAll();
    render();
    setStatus(`totalCoin=${r.totalCoin || ''}`);
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e));
    alert(String(e && e.message ? e.message : e));
  } finally {
    if (b) { b.disabled = false; b.textContent = '刷新'; }
  }
}

async function previewCookie(p) {
  const rec = p.record || {};
  showModal('查看 cookies profile', el('div', {}, [
    el('div', { class: 'hint' }, ['该对象会被后端解析为 Cookie/localStorage，并用于请求 create/history。']),
    el('textarea', { spellcheck: 'false' }, [pretty({ host: p.host, record: rec })])
  ]));
}

async function deleteCookie(id) {
  if (!confirm('确认删除该 cookie profile？')) return;
  await api('DELETE', `/api/cookies/${id}`);
  await refreshAll();
  render();
}

async function exportCookies() {
  const data = await api('GET', '/api/cookies/export');
  showModal('导出 cookies（multi）', el('div', {}, [
    el('textarea', { spellcheck: 'false' }, [pretty(data)])
  ]));
}

async function importCookies() {
  const ta = el('textarea', { spellcheck: 'false', placeholder: '粘贴 cookies.txt 或 multicookies.txt 的 JSON' });
  const box = el('div', {}, [
    el('div', { class: 'hint' }, ['支持单条（{host,record}）和多条（{records:{host:[record...]}}）。']),
    ta,
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px;' }, [
      el('button', { class: 'btn ghost', onclick: closeModal }, ['取消']),
      el('button', {
        class: 'btn warn',
        onclick: async () => {
          const j = safeJsonParse(ta.value);
          if (!j) { alert('JSON 解析失败'); return; }
          await api('POST', '/api/cookies/import', j);
          await refreshAll();
          closeModal();
          render();
        }
      }, ['导入'])
    ])
  ]);
  showModal('导入 cookies', box);
}

function renderResources() {
  const root = $('#view-resources');
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'h1' }, ['资源库']));
  root.appendChild(el('div', { class: 'hint' }, [
    '仿照 runninghub.js：上传任意文件到 RunningHub（upload/image），响应返回的 name 会写入资源库。生成时可从表格右侧“资源库”列一键替换上传字段。'
  ]));

  const profSel = el('select');
  state.profiles.forEach(p => profSel.appendChild(el('option', { value: p.id }, [`${p.name || p.id} (${p.host || ''})`])));

  const tplSel = el('select');
  tplSel.appendChild(el('option', { value: '' }, ['(可选) 选择模板用于 referrer/webappId']));
  state.templates.forEach(t => tplSel.appendChild(el('option', { value: t.id }, [t.name || t.id])));

  const fileInput = el('input', { type: 'file' });

  const uploadBtn = el('button', {
    class: 'btn good',
    onclick: async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) { alert('请选择文件'); return; }
      if (!profSel.value) { alert('请选择 cookies profile'); return; }

      let webappId = '';
      if (tplSel.value) {
        const t = state.templates.find(x => x.id === tplSel.value);
        webappId = String(t?.webappId || t?.payload?.webappId || '').trim();
      }

      const fd = new FormData();
      fd.append('profileId', profSel.value);
      fd.append('webappId', webappId);
      fd.append('file', f);

      setStatus('uploading...');
      const r = await fetch('/api/resources/upload', { method: 'POST', body: fd });
      const text = await r.text();
      const j = safeJsonParse(text);
      if (!r.ok) {
        setStatus('');
        throw new Error((j && j.detail) ? j.detail : `HTTP ${r.status}: ${text}`);
      }

      setStatus(`uploaded: ${j.resource?.name || ''}`);
      await refreshAll();
      render();
    }
  }, ['上传到 RunningHub']);

  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'label' }, ['Cookies profile（用于 auth）']), profSel]),
      el('div', { class: 'grow' }, [el('div', { class: 'label' }, ['模板（用于 referrer，可选）']), tplSel]),
    ]),
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'label' }, ['选择文件']), fileInput]),
      uploadBtn,
    ]),
    el('div', { class: 'hint' }, ['upload 需要 cookies 里的 Rh-Comfy-Auth + Rh-Identify（在 localStorage 中）。']),
  ]));

  const tools = el('div', { class: 'row', style: 'margin-top:10px;' }, [
    el('button', { class: 'btn', onclick: async () => {
      const data = await api('GET', '/api/resources/export');
      showModal('导出资源库', el('div', {}, [el('textarea', { spellcheck: 'false' }, [pretty(data)])]));
    } }, ['导出资源库']),
    el('button', { class: 'btn warn', onclick: async () => {
      const ta = el('textarea', { spellcheck: 'false', placeholder: '粘贴 resources JSON（{resources:[...]} 或 [...]）' });
      showModal('导入资源库', el('div', {}, [
        ta,
        el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, [
          el('button', { class: 'btn ghost', onclick: closeModal }, ['取消']),
          el('button', { class: 'btn warn', onclick: async () => {
            const j = safeJsonParse(ta.value);
            if (!j) { alert('JSON 解析失败'); return; }
            await api('POST', '/api/resources/import', j);
            await refreshAll();
            closeModal();
            render();
          } }, ['导入'])
        ])
      ]));
    } }, ['导入资源库']),
  ]);
  root.appendChild(tools);

  if (!state.resources.length) {
    root.appendChild(el('div', { class: 'card hint' }, ['资源库为空。']));
    return;
  }

  const table = el('table', { class: 'table', style: 'margin-top:12px;' }, []);
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['name（用于 fieldValue）']),
      el('th', {}, ['预览']),
      el('th', {}, ['原文件名']),
      el('th', {}, ['webappId']),
      el('th', {}, ['profile']),
      el('th', {}, ['时间']),
      el('th', {}, ['操作']),
    ])
  ]));
  const tb = el('tbody');

  state.resources.forEach(r => {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'mono' }, [String(r.name || '')]));
    tr.appendChild(el('td', { class: 'preview-cell' }, [buildInlinePreview(String(r.localUrl || ''), String(r.localPath || r.name || r.originalFilename || ''))]));
    tr.appendChild(el('td', {}, [String(r.originalFilename || '')]));
    tr.appendChild(el('td', { class: 'mono' }, [String(r.webappId || '')]));
    tr.appendChild(el('td', {}, [String(r.profileName || r.profileId || '')]));
    tr.appendChild(el('td', {}, [fmtTime(r.updatedAt)]));
    tr.appendChild(el('td', {}, [
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', onclick: async () => {
          try { await navigator.clipboard.writeText(String(r.name || '')); setStatus('copied'); } catch { setStatus('copy failed'); }
        } }, ['复制 name']),
        el('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('确认删除该资源记录？')) return;
          await api('DELETE', `/api/resources/${r.id}`);
          await refreshAll();
          render();
        } }, ['删除']),
      ])
    ]));
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  root.appendChild(table);
}

function renderGenerate() {
  const root = $('#view-generate');
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'h1' }, ['一键生成']));
  root.appendChild(el('div', { class: 'hint' }, [
    '选择模板 + cookies profile，然后编辑本次 payload，点击开始。生成会在后台并发执行，去“任务”页查看状态与下载。'
  ]));

  const tplSel = el('select');
  state.templates.forEach(t => tplSel.appendChild(el('option', { value: t.id }, [t.name || t.id])));
  // Hide cookie profiles that are already in use by queued/running jobs.
  const inUse = new Set(
    (state.jobs || [])
      .filter(j => j && (j.status === 'queued' || j.status === 'running') && j.profileId)
      .map(j => String(j.profileId))
  );
  const availableProfiles = (state.profiles || []).filter(p => p && p.id && !inUse.has(String(p.id)));
  const profSel = el('select');
  availableProfiles.forEach(p => {
    const coin = (p && p.totalCoin !== undefined && p.totalCoin !== null && String(p.totalCoin).trim()) ? String(p.totalCoin).trim() : '-';
    profSel.appendChild(el('option', { value: p.id }, [(p.name || p.id) + ' (' + (p.host || '') + ') [剩余积分: ' + coin + ']']));
  });

  const payload = el('textarea', { spellcheck: 'false' }, [
    state.templates[0] ? pretty(state.templates[0].payload || {}) : '{}'
  ]);
  const inputsBox = el('div', { class: 'card', style: 'display:none' });

  tplSel.addEventListener('change', () => {
    const t = state.templates.find(x => x.id === tplSel.value);
    payload.value = pretty((t && t.payload) ? t.payload : {});
    inputsBox.style.display = 'none';
    inputsBox.innerHTML = '';
  });

  const noAuth = el('select', {}, [
    el('option', { value: '0' }, ['发送 Authorization（推荐）']),
    el('option', { value: '1' }, ['不发送 Authorization（仅 Cookie）'])
  ]);

  const btn = el('button', {
    class: 'btn good',
    onclick: async () => {
      const p = safeJsonParse(payload.value);
      if (!p || typeof p !== 'object') { alert('payload 不是合法 JSON 对象'); return; }
      if (!tplSel.value || !profSel.value) { alert('请选择模板和 cookies'); return; }
      const body = { templateId: tplSel.value, profileId: profSel.value, payload: p, noAuth: noAuth.value === '1' };
      const r = await api('POST', '/api/jobs', body);
      setStatus(`job started: ${r.job.id}`);
      await refreshAll();
      setView('jobs');
      render();
    }
  }, ['开始生成（后台）']);

  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'label' }, ['模板']), tplSel]),
      el('div', { class: 'grow' }, [el('div', { class: 'label' }, ['Cookies profile']), profSel]),
      el('div', { class: 'grow' }, [el('div', { class: 'label' }, ['鉴权方式']), noAuth]),
    ]),
    (availableProfiles.length === 0 && (state.profiles || []).length > 0) ? el('div', { class: 'hint', style: 'margin-top:10px;color:#b91c1c' }, [
      '当前没有可用 cookies：所有 cookies 都正在被运行/排队中的任务占用。'
    ]) : el('span'),
    el('div', { class: 'label', style: 'margin-top:10px;' }, ['本次 payload（JSON）']),
    payload,
    el('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px;' }, [
      el('button', {
        class: 'btn',
        onclick: () => {
          inputsBox.style.display = 'block';
          mountInputsTable(inputsBox, payload, state.resources);
        }
      }, ['渲染 inputs 表格']),
      el('div', { class: 'hint' }, ['表格编辑会实时回写 JSON。'])
    ]),
    inputsBox,
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px;' }, [
      (availableProfiles.length === 0 && (state.profiles || []).length > 0) ? (() => {
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';
        return btn;
      })() : btn
    ]),
  ]));
}

function pill(job) {
  const s = job.status || 'unknown';
  if (s === 'success') return el('span', { class: 'pill ok' }, ['success']);
  if (s === 'failed') return el('span', { class: 'pill bad' }, ['failed']);
  if (s === 'running') return el('span', { class: 'pill run' }, ['running']);
  if (s === 'cancelled') return el('span', { class: 'pill bad' }, ['cancelled']);
  return el('span', { class: 'pill q' }, [s]);
}

function renderJobs() {
  const root = $('#view-jobs');
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'h1' }, ['任务']));

  const tools = el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px;' }, [
    el('div', { class: 'hint' }, ['自动刷新：每 3 秒']),
    el('button', { class: 'btn', onclick: async () => { await refreshAll(); render(); } }, ['手动刷新']),
  ]);
  root.appendChild(tools);

  if (state.jobs.length === 0) {
    root.appendChild(el('div', { class: 'card hint' }, ['暂无任务。']));
    return;
  }

  state.jobs.forEach(j => {
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'row', style: 'justify-content:space-between;' }, [
        el('div', {}, [
          el('div', { style: 'font-weight:900' }, [`${j.templateName || j.templateId}  /  ${j.profileName || j.profileId}`]),
          el('div', { class: 'hint' }, [`jobId: ${j.id} | 创建: ${fmtTime(j.createdAt)} | 更新: ${fmtTime(j.updatedAt)}`]),
        ]),
        pill(j)
      ]),
      el('div', { class: 'row', style: 'margin-top:10px;' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'label' }, ['taskId']),
          el('div', { class: 'mono' }, [String(j.taskId || '')]),
        ]),
        el('div', { class: 'grow' }, [
          el('div', { class: 'label' }, ['taskStatus']),
          el('div', {}, [String(j.taskStatus || '')]),
        ]),
      ]),
      el('div', { class: 'row', style: 'margin-top:10px;justify-content:flex-end;' }, [
        j.downloadPath ? el('a', { class: 'btn good', href: j.downloadPath, target: '_blank' }, ['下载文件']) : el('span', { class: 'hint' }, ['暂无下载文件']),
        el('button', { class: 'btn', onclick: () => showJobLogs(j) }, ['日志']),
      ]),
      (j.extractedFiles && j.extractedFiles.length) ? el('div', { style: 'margin-top:10px' }, [
        el('div', { class: 'label' }, ['已解压文件']),
        el('div', { class: 'hint' }, ['点击即可下载。']),
        el('div', { class: 'row' }, j.extractedFiles.slice(0, 12).map(u =>
          el('a', { class: 'btn ghost', href: u, target: '_blank' }, [u.split('/').slice(-1)[0]])
        )),
        (j.extractedFiles.length > 12) ? el('div', { class: 'hint', style: 'margin-top:6px' }, [`还有 ${j.extractedFiles.length - 12} 个文件未展示（避免挤爆页面）。`]) : el('span')
      ]) : el('span'),
      j.error ? el('div', { class: 'hint', style: 'margin-top:10px;color:#b91c1c' }, [String(j.error)]) : el('span')
    ]);
    root.appendChild(card);
  });
}

function showJobLogs(j) {
  showModal('任务日志', el('div', {}, [
    el('div', { class: 'hint' }, ['只展示本地 job 日志，不包含敏感 token/cookie。']),
    el('textarea', { spellcheck: 'false' }, [String((j.logs || []).join('\n'))])
  ]));
}

function render() {
  renderTemplates();
  renderCookies();
  renderResources();
  renderGenerate();
  renderJobs();
  renderDownloads();
  renderSettings();
}

function formatBytes(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function guessMediaKindByPath(path) {
  const p = String(path || '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) return 'image';
  if (/\.(mp4|webm|mov|m4v|mkv)$/i.test(p)) return 'video';
  if (/\.(mp3|wav|m4a|flac|ogg|opus|aac)$/i.test(p)) return 'audio';
  if (/\.(json|txt|log|csv|yaml|yml)$/i.test(p)) return 'text';
  return 'other';
}

function buildInlinePreview(url, nameOrPath) {
  const src = String(url || '');
  if (!src) return el('span', { class: 'hint' }, ['-']);

  const kind = guessMediaKindByPath(nameOrPath);
  if (kind === 'image') {
    return el('img', { class: 'media-preview img', src, loading: 'lazy' });
  }
  if (kind === 'video') {
    // Use preload=none to avoid fetching all previews at once.
    return el('video', { class: 'media-preview video', src, controls: 'true', preload: 'none' });
  }
  if (kind === 'audio') {
    return el('audio', { class: 'media-preview audio', src, controls: 'true', preload: 'none' });
  }
  return el('span', { class: 'hint' }, ['-']);
}

function renderDownloads() {
  const root = $('#view-downloads');
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'h1' }, ['下载']));
  root.appendChild(el('div', { class: 'hint' }, [
    '这里会列出服务端下载目录（webapp/downloads）下的所有文件。音频/视频/图片会直接在表格中内嵌预览。'
  ]));

  const q = el('input', { placeholder: '筛选文件名/路径（模糊匹配）' });
  const onlyMedia = el('select', {}, [
    el('option', { value: '0' }, ['全部']),
    el('option', { value: '1' }, ['仅媒体（音/视频/图片）']),
  ]);

  const refreshBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      const d = await api('GET', '/api/downloads');
      state.downloads = d.items || [];
      renderDownloads();
    }
  }, ['刷新']);

  root.appendChild(el('div', { class: 'row', style: 'margin-top:10px;' }, [
    el('div', { class: 'grow' }, [q]),
    onlyMedia,
    refreshBtn,
  ]));

  const list = Array.isArray(state.downloads) ? state.downloads : [];
  if (!list.length) {
    root.appendChild(el('div', { class: 'card hint' }, ['暂无下载文件。']));
    return;
  }

  function applyFilter() {
    const needle = String(q.value || '').trim().toLowerCase();
    const mediaOnly = onlyMedia.value === '1';
    let items = list;
    if (needle) items = items.filter(it => String(it.path || it.name || '').toLowerCase().includes(needle));
    if (mediaOnly) items = items.filter(it => {
      const kind = guessMediaKindByPath(it.path || it.name);
      return kind === 'image' || kind === 'video' || kind === 'audio';
    });
    return items;
  }

  const table = el('table', { class: 'table', style: 'margin-top:12px;' }, []);
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['文件']),
      el('th', {}, ['预览']),
      el('th', {}, ['大小']),
      el('th', {}, ['修改时间']),
      el('th', {}, ['操作']),
    ])
  ]));
  const tb = el('tbody');

  function renderRows() {
    tb.innerHTML = '';
    const items = applyFilter();
    if (!items.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'hint' }, ['无匹配文件。'])]));
      return;
    }

    items.forEach(it => {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'mono' }, [String(it.path || it.name || '')]));
      tr.appendChild(el('td', { class: 'preview-cell' }, [buildInlinePreview(String(it.url || ''), String(it.path || it.name || ''))]));
      tr.appendChild(el('td', {}, [formatBytes(it.size)]));
      tr.appendChild(el('td', {}, [fmtTime(it.modifiedAt)]));
      tr.appendChild(el('td', {}, [
        el('div', { class: 'row' }, [
          el('a', { class: 'btn good', href: String(it.url || ''), target: '_blank' }, ['下载']),
        ])
      ]));
      tb.appendChild(tr);
    });
  }

  q.addEventListener('input', renderRows);
  onlyMedia.addEventListener('change', renderRows);

  renderRows();
  table.appendChild(tb);
  root.appendChild(table);
}

function renderSettings() {
  const root = $('#view-settings');
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'h1' }, ['设置']));
  root.appendChild(el('div', { class: 'hint' }, [
    '用于控制后台线程的超时与轮询频率。默认超时 10 分钟；服务端收到 Ctrl+C/关闭信号后也会尽快取消后台任务。'
  ]));

  const cur = state.settings || {};

  const jobTimeout = el('input', { type: 'number', min: '30', max: String(24 * 3600), value: String(cur.jobTimeoutSec ?? 600) });
  const interval = el('input', { type: 'number', min: '0.5', max: '60', step: '0.5', value: String(cur.historyIntervalSec ?? 3.0) });
  const reqTimeout = el('input', { type: 'number', min: '3', max: '120', step: '1', value: String(cur.requestTimeoutSec ?? 25.0) });

  const saveBtn = el('button', {
    class: 'btn good',
    onclick: async () => {
      const body = {
        jobTimeoutSec: Number(jobTimeout.value),
        historyIntervalSec: Number(interval.value),
        requestTimeoutSec: Number(reqTimeout.value),
      };
      const r = await api('PUT', '/api/settings', body);
      state.settings = r.settings || state.settings;
      setStatus('settings saved');
      renderSettings();
    }
  }, ['保存设置']);

  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, ['任务超时（秒）']),
        jobTimeout,
        el('div', { class: 'hint' }, ['超过这个时间会将任务标记为失败并停止轮询/下载。默认 600 秒。'])
      ]),
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, ['轮询间隔（秒）']),
        interval,
        el('div', { class: 'hint' }, ['history 接口轮询间隔。'])
      ]),
    ]),
    el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, ['单次请求超时（秒）']),
        reqTimeout,
        el('div', { class: 'hint' }, ['create/history/download 单次请求超时。'])
      ]),
    ]),
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px;' }, [saveBtn]),
  ]));
}

async function boot() {
  setStatus('loading...');
  try {
    await refreshAll();
    render();
    setStatus('ready');
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e));
  }

  // auto refresh jobs
  setInterval(async () => {
    const view = document.querySelector('.navbtn.active')?.dataset?.view;
    if (view !== 'jobs') return;
    try {
      const j = await api('GET', '/api/jobs');
      state.jobs = j.jobs || [];
      renderJobs();
    } catch (e) {
      // ignore
    }
  }, 3000);
}

boot();
