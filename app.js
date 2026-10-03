const { createClient } = window.supabase;
const sb = createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_PUBLISHABLE_KEY);

const state = {
  user: null, role: null, profile: null, online: navigator.onLine,
  students: [], infractions: [], suspensions: [], referrals: [], positiveBehaviors: [], notes: [], staff: [], audit: [], photoUrls: new Map(),
  currentPage: "dashboard"
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const ROLE_LABELS = {
  dean: "Dean of Discipline",
  principal: "Principal",
  vice_principal: "Vice Principal",
  guidance_counsellor: "Guidance Counsellor",
  grade_supervisor: "Grade Supervisor"
};

const IDB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("stjames_behavior_tracker", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        ["students","infractions","suspensions","referrals","positive_behaviors","notes","queue"].forEach(s => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async put(store, item) {
    const db = await this.open();
    return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).put(item);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
  },
  async all(store) {
    const db = await this.open();
    return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readonly");const req=tx.objectStore(store).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error)});
  },
  async del(store,id) {
    const db = await this.open();
    return new Promise((resolve,reject)=>{const tx=db.transaction(store,"readwrite");tx.objectStore(store).delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
  }
};

function toast(message, type="info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toast-root").appendChild(el);
  setTimeout(()=>el.remove(), 3200);
}
const styleToast = document.createElement("style");
styleToast.textContent = `.toast{position:fixed;right:18px;bottom:18px;z-index:100;padding:12px 15px;border-radius:12px;background:#17191d;color:#fff;box-shadow:0 12px 30px rgba(0,0,0,.2);font-size:13px}.toast.success{background:#137333}.toast.error{background:#b42318}`;
document.head.appendChild(styleToast);

function setOnline(v) {
  state.online = v;
  $("#sync-label").textContent = v ? "Online" : "Offline";
  $("#sync-dot").parentElement.classList.toggle("offline", !v);
}
window.addEventListener("online", async()=>{setOnline(true); await flushQueue(); await loadAll(); toast("Connection restored and local changes synced.","success")});
window.addEventListener("offline",()=>{setOnline(false);toast("Offline mode enabled. New records will sync when connected.")});

function escapeHtml(s="") { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function fmtDate(v) { if(!v) return "—"; return new Date(v).toLocaleString([], {dateStyle:"medium",timeStyle:"short"}); }
function today() { return new Date().toISOString().slice(0,10); }

async function loadAll() {
  if (!state.online) {
    state.students = await IDB.all("students");
    state.infractions = await IDB.all("infractions");
    state.suspensions = await IDB.all("suspensions");
    state.referrals = await IDB.all("referrals");
    state.positiveBehaviors = await IDB.all("positive_behaviors");
    state.notes = await IDB.all("notes");
    render();
    return;
  }
  const tables = [
    ["students","students"],["infractions","infractions"],["suspensions","suspensions"],
    ["referrals","referrals"],["behavior_notes","notes"]
  ];
  for (const [table, key] of tables) {
    const {data,error} = await sb.from(table).select("*").order("created_at",{ascending:false});
    if (error) { console.error(error); continue; }
    state[key] = data || [];
    const cached = await IDB.all(key);
    for (const item of cached) if (!state[key].some(x=>x.id===item.id)) await IDB.del(key,item.id);
    for (const item of state[key]) await IDB.put(key,item);
  }
  if (state.role === "dean") await loadAudit();
  await refreshPhotoUrls();
  render();
}

async function refreshPhotoUrls() {
  if (!state.online) return;
  const withPhotos = state.students.filter(s => s.profile_photo_path);
  await Promise.all(withPhotos.map(async s => {
    try {
      const { data, error } = await sb.storage.from("student-photos").createSignedUrl(s.profile_photo_path, 3600);
      if (!error && data?.signedUrl) state.photoUrls.set(s.id, data.signedUrl);
    } catch (e) { console.warn("photo url", e); }
  }));
}

async function loadAudit() {
  if (state.role !== "dean" || !state.online) return;
  const { data, error } = await sb.from("audit_log").select("id,table_name,record_id,action,actor_id,old_data,new_data,created_at").order("created_at", { ascending:false }).limit(200);
  if (error) { console.warn("audit load", error); return; }
  state.audit = data || [];
}

async function flushQueue() {
  if (!state.online) return;
  const q = await IDB.all("queue");
  for (const item of q.sort((a,b)=>a.created_at-b.created_at)) {
    try {
      let result;
      const payload = {...(item.data || {})};
      delete payload._offline;
      if (item.op === "insert") {
        result = await sb.from(item.table).insert(payload);
        if (result?.error?.code === "23505" && payload.client_request_id) {
          const existing = await sb.from(item.table).select().eq("client_request_id", payload.client_request_id).maybeSingle();
          if (!existing.error && existing.data) result = { data: existing.data };
        }
      }
      else if (item.op === "update") { delete payload.id; result = await sb.from(item.table).update(payload).eq("id",item.record_id); }
      else if (item.op === "delete") result = await sb.from(item.table).delete().eq("id",item.record_id);
      if (result?.error) throw result.error;
      await IDB.del("queue",item.id);
    } catch(e) {
      console.error("sync failed", e);
      break;
    }
  }
  await loadAll();
}

async function mutate(table, data, op="insert") {
  if (state.online) {
    let r;
    if(op==="insert") {
      r=await sb.from(table).insert(data).select().single();
      if (r?.error?.code === "23505" && data.client_request_id) {
        const existing = await sb.from(table).select().eq("client_request_id", data.client_request_id).maybeSingle();
        if (!existing.error && existing.data) r={data:existing.data};
      }
    }
    if(op==="update") r=await sb.from(table).update(data).eq("id",data.id).select().single();
    if(op==="delete") r=await sb.from(table).delete().eq("id",data.id);
    if(r?.error) throw r.error;
    return r?.data;
  }
  const temp = {...data, id: data.id || crypto.randomUUID(), _offline:true};
  const key = table==="behavior_notes"?"notes":table;
  if(op==="insert") { state[key].unshift(temp); await IDB.put(key,temp); }
  if(op==="update") {
    const idx=state[key].findIndex(x=>x.id===temp.id);
    if(idx>=0) state[key][idx]={...state[key][idx],...temp};
    await IDB.put(key,temp);
  }
  if(op==="delete") {
    state[key]=state[key].filter(x=>x.id!==temp.id);
    await IDB.del(key,temp.id);
  }
  await IDB.put("queue",{id:crypto.randomUUID(),created_at:Date.now(),table,op,record_id:temp.id,data:temp});
  return temp;
}

async function boot() {
  setOnline(navigator.onLine);
  const {data:{session}} = await sb.auth.getSession();
  if (session) await startApp(session.user);
  else showLogin();
  sb.auth.onAuthStateChange(async (_event, session) => {
    if(session?.user) await startApp(session.user); else showLogin();
  });
}

async function startApp(user) {
  state.user = user;
  const {data: roleData} = await sb.rpc("current_user_role");
  state.role = roleData || null;
  const {data: profile} = await sb.from("profiles").select("id,full_name,role,active").eq("id",user.id).maybeSingle();
  state.profile = profile || {full_name:user.email?.split("@")[0] || "Staff",role:state.role};
  if(state.profile.active === false) { await sb.auth.signOut(); return; }
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-name").textContent = state.profile.full_name || "Staff";
  $("#welcome-name").textContent = (state.profile.full_name || "Staff").split(" ")[0];
  $("#user-role").textContent = ROLE_LABELS[state.role] || "Staff";
  $("#user-avatar").textContent = (state.profile.full_name || "S").trim().charAt(0).toUpperCase();
  $$(".dean-only").forEach(x=>x.classList.toggle("hidden",state.role!=="dean"));
  await loadAll();
  if(state.role==="dean") await loadStaff();
  showPage("dashboard");
}

function showLogin() {
  $("#app-view").classList.add("hidden"); $("#login-view").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async e=>{
  e.preventDefault(); $("#login-error").textContent="";
  const {error}=await sb.auth.signInWithPassword({email:$("#login-email").value.trim(),password:$("#login-password").value});
  if(error) $("#login-error").textContent=error.message;
});

$("#signout-btn").addEventListener("click",()=>sb.auth.signOut());
$("#edit-my-profile-btn").addEventListener("click",()=>staffEditForm(state.user.id));

function showPage(page) {
  state.currentPage=page;
  $$(".page").forEach(x=>x.classList.add("hidden"));
  $(`#page-${page}`).classList.remove("hidden");
  $$(".nav-item[data-page]").forEach(x=>x.classList.toggle("active",x.dataset.page===page));
  const titles={dashboard:"Dashboard",students:"Students",positive:"Positive Behaviour",reports:"Reports",staff:"Staff Accounts",audit:"Audit Log"};
  $("#page-title").textContent=titles[page];
  render();
}
$("#main-nav").addEventListener("click",e=>{const b=e.target.closest("[data-page]");if(b)showPage(b.dataset.page)});
$$("[data-page-link]").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.pageLink)));
$("#quick-add-btn").addEventListener("click",()=>openRecordChooser());
$$("[data-action]").forEach(b=>b.addEventListener("click",()=>openAction(b.dataset.action)));

function render() {
  const now = new Date(), todayKey = now.toISOString().slice(0,10);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todaysInfractions = state.infractions.filter(x => String(x.occurred_at||'').slice(0,10) === todayKey).length;
  const activeSuspensions = state.suspensions.filter(x => x.start_at && (!x.end_at || new Date(x.end_at) >= now) && new Date(x.start_at) <= now).length;
  const monthlyReferrals = state.referrals.filter(x => x.referred_at && new Date(x.referred_at) >= monthStart).length;
  const positiveCount = state.positiveBehaviors.length;
  $('#stat-students').textContent = state.students.length;
  $('#stat-infractions').textContent = todaysInfractions;
  $('#stat-suspensions').textContent = activeSuspensions;
  $('#stat-referrals').textContent = monthlyReferrals;
  $('#stat-positive').textContent = positiveCount;
  $('#hero-role').textContent = ROLE_LABELS[state.role] || 'Staff';
  const contacts=state.infractions.filter(x=>x.parent_contacted).length;
  $('#report-contacts').textContent=contacts;
  $('#report-followups').textContent=state.infractions.filter(x=>x.follow_up_date).length+state.referrals.filter(x=>x.follow_up_date).length;
  $('#report-active-suspensions').textContent=activeSuspensions;
  const activities=[
    ...state.infractions.map(x=>({date:x.occurred_at,type:'Infraction',text:x.infraction_type,student:studentName(x.student_id),tone:'red'})),
    ...state.suspensions.map(x=>({date:x.start_at,type:'Suspension',text:x.reason,student:studentName(x.student_id),tone:'orange'})),
    ...state.referrals.map(x=>({date:x.referred_at,type:'Referral',text:x.referral_type,student:studentName(x.student_id),tone:'blue'})),
    ...state.positiveBehaviors.map(x=>({date:x.recorded_at,type:'Positive Behaviour',text:x.behavior_type,student:studentName(x.student_id),tone:'green'}))
  ].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,7);
  $('#recent-activity').innerHTML=activities.length?activities.map(a=>`<div class="activity"><span class="dot ${a.tone}"></span><div><strong>${escapeHtml(a.type)} · ${escapeHtml(a.student)}</strong><small>${escapeHtml(a.text)} · ${fmtDate(a.date)}</small></div></div>`).join(''):`<div class="empty">No activity recorded yet.</div>`;
  renderBehaviorChart();
  renderGradeChart();
  renderNotifications();
  renderPositive();
  renderStudents();
  renderReports();
  renderAudit();
}

function renderBehaviorChart() {
  const values=[
    ['Infractions',state.infractions.length,'red'],
    ['Suspensions',state.suspensions.length,'orange'],
    ['Referrals',state.referrals.length,'blue'],
    ['Positive',state.positiveBehaviors.length,'green']
  ];
  const max=Math.max(1,...values.map(v=>v[1]));
  $('#behavior-chart').innerHTML=values.map(([label,val,tone])=>`<div class="chart-col"><div class="chart-value">${val}</div><div class="chart-bar ${tone}" style="height:${Math.max(12,(val/max)*150)}px"></div><span>${label}</span></div>`).join('');
}
function renderGradeChart() {
  const grades=[...new Set(state.students.map(s=>s.grade).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));
  const rows=grades.map(g=>[g,state.students.filter(s=>s.grade===g).length]);
  const max=Math.max(1,...rows.map(r=>r[1]));
  $('#grade-chart').innerHTML=rows.length?rows.map(([g,n])=>`<div class="grade-row"><span>Grade ${escapeHtml(g)}</span><div><i style="width:${Math.max(4,(n/max)*100)}%"></i></div><b>${n}</b></div>`).join(''):`<div class="empty">No grade data yet.</div>`;
}
function renderNotifications() {
  const active=state.suspensions.filter(x=>x.start_at && (!x.end_at || new Date(x.end_at)>=new Date()) && new Date(x.start_at)<=new Date()).length;
  const today=state.infractions.filter(x=>String(x.occurred_at||'').slice(0,10)===new Date().toISOString().slice(0,10)).length;
  const pending=state.online?0:1;
  const rows=[
    [active,'Active suspension(s)','red'],
    [today,'Infraction(s) recorded today','blue'],
    [pending,'Offline changes waiting to sync','orange'],
    [state.positiveBehaviors.filter(x=>String(x.recorded_at||'').slice(0,10)===new Date().toISOString().slice(0,10)).length,'Positive behaviour record(s) today','green']
  ];
  $('#notifications-list').innerHTML=rows.map(([n,t,tone])=>`<div class="notification"><span class="notification-icon ${tone}">${tone==='red'?'!':tone==='green'?'★':'+'}</span><strong>${n}</strong><span>${t}</span></div>`).join('');
}

function renderPositive() {
  const el=$('#positive-table'); if(!el) return;
  const rows=state.positiveBehaviors.slice().sort((a,b)=>new Date(b.recorded_at)-new Date(a.recorded_at));
  el.innerHTML=rows.length?`<table class="data-table"><thead><tr><th>Date</th><th>Student</th><th>Behaviour</th><th>Description</th><th>Recognition</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${fmtDate(x.recorded_at)}</td><td><button class="student-link" data-student="${x.student_id}">${escapeHtml(studentName(x.student_id))}</button></td><td><span class="tag positive-tag">${escapeHtml(x.behavior_type)}</span></td><td>${escapeHtml(x.description||'—')}</td><td>${escapeHtml(x.recognition||'—')}</td></tr>`).join('')}</tbody></table>`:`<div class="empty">No positive behaviour records yet.</div>`;
  $$('#positive-table [data-student]').forEach(b=>b.addEventListener('click',()=>openStudent(b.dataset.student)));
}

function studentName(id) { return state.students.find(s=>s.id===id)?.name || "Unknown student"; }

function renderRoleWorkspace(){
  const el=$("#role-workspace"); if(!el) return;
  const sets={
    vice_principal:[["Students","Student profiles and student information","students"],["Behavior & Discipline","Infractions, suspensions and behavior reports","reports"]],
    grade_supervisor:[["Students by Grade","Review and manage students by grade/class","students"],["Grade Behaviour Reports","Review grade-level behaviour data","reports"]],
    guidance_counsellor:[["Referrals & Interventions","Track referrals, destinations and follow-ups","reports"],["Positive Behaviour","Recognize and monitor positive conduct","positive"],["Student Notes","Review student-support notes and interventions","students"],["Reports","Review student-support activity","reports"]]
  };
  const items=sets[state.role]||[]; if(!items.length){el.innerHTML="";return;}
  el.innerHTML=`<section class="panel role-workspace"><div class="panel-head"><div><h3>My Role Sections</h3><p>${escapeHtml(ROLE_LABELS[state.role]||"Staff")} workspace</p></div></div><div class="role-section-grid">${items.map(([title,desc,page])=>`<button class="role-section-card" data-role-page="${page}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(desc)}</span><b>Open →</b></button>`).join("")}</div></section>`;
  $$('[data-role-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.rolePage)));
}

function renderStudents() {
  const q=($("#student-search")?.value||"").toLowerCase();
  const grade=$("#grade-filter")?.value||"", shift=$("#shift-filter")?.value||"";
  const grades=[...new Set(state.students.map(s=>s.grade).filter(Boolean))].sort();
  const shifts=[...new Set(state.students.map(s=>s.shift).filter(Boolean))].sort();
  if($("#grade-filter")) $("#grade-filter").innerHTML='<option value="">All grades</option>'+grades.map(g=>`<option ${g===grade?"selected":""}>${escapeHtml(g)}</option>`).join("");
  if($("#shift-filter")) $("#shift-filter").innerHTML='<option value="">All shifts</option>'+shifts.map(g=>`<option ${g===shift?"selected":""}>${escapeHtml(g)}</option>`).join("");
  const rows=state.students.filter(s=>{
    const hay=[s.name,s.student_id,s.parent_name,s.class,s.grade].join(" ").toLowerCase();
    return (!q||hay.includes(q))&&(!grade||s.grade===grade)&&(!shift||s.shift===shift);
  });
  $("#student-table").innerHTML=rows.length?`<table class="data-table"><thead><tr><th>Student</th><th>Grade/Class</th><th>Shift</th><th>Parent</th><th>Phone</th><th>Records</th></tr></thead><tbody>${rows.map(s=>{
    const count=state.infractions.filter(x=>x.student_id===s.id).length+state.suspensions.filter(x=>x.student_id===s.id).length+state.referrals.filter(x=>x.student_id===s.id).length;
    return `<tr><td><div style="display:flex;align-items:center"><span class="avatar-small">${state.photoUrls.get(s.id)?`<img src="${escapeHtml(state.photoUrls.get(s.id))}" alt="">`:escapeHtml((s.name||"S").charAt(0))}</span><div><button class="student-link" data-student="${s.id}">${escapeHtml(s.name)}</button><div class="muted">${escapeHtml(s.student_id||"No ID")}</div></div></div></td><td>${escapeHtml(s.grade||"—")} / ${escapeHtml(s.class||"—")}</td><td>${escapeHtml(s.shift||"—")}</td><td>${escapeHtml(s.parent_name||"—")}</td><td>${escapeHtml(s.parent_phone||"—")}</td><td><span class="tag">${count}</span></td></tr>`;
  }).join("")}</tbody></table>`:`<div class="empty">No students match the current filters.</div>`;
  $$("#student-table [data-student]").forEach(b=>b.addEventListener("click",()=>openStudent(b.dataset.student)));
}
["student-search","grade-filter","shift-filter"].forEach(id=>$(("#"+id)).addEventListener("input",renderStudents));

function behaviorRecordMonth(record, type) {
  const raw = type === "infraction" ? record.occurred_at : type === "suspension" ? record.start_at : type === "referral" ? record.referred_at : record.recorded_at;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return { key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label: d.toLocaleString(undefined,{month:"long",year:"numeric"}), time:d.getTime() };
}

function buildMonthlyReportRows() {
  const byKey = new Map();
  const ensure = (month, student) => {
    if (!month) return null;
    const key = `${month.key}|${student.id}`;
    if (!byKey.has(key)) byKey.set(key,{monthKey:month.key,monthLabel:month.label,monthTime:month.time,student,inf:0,susp:0,ref:0,positive:0});
    return byKey.get(key);
  };
  state.infractions.forEach(r=>{const s=state.students.find(x=>x.id===r.student_id),m=behaviorRecordMonth(r,"infraction"); if(s&&m)ensure(m,s).inf++;});
  state.suspensions.forEach(r=>{const s=state.students.find(x=>x.id===r.student_id),m=behaviorRecordMonth(r,"suspension"); if(s&&m)ensure(m,s).susp++;});
  state.referrals.forEach(r=>{const s=state.students.find(x=>x.id===r.student_id),m=behaviorRecordMonth(r,"referral"); if(s&&m)ensure(m,s).ref++;});
  state.positiveBehaviors.forEach(r=>{const s=state.students.find(x=>x.id===r.student_id),m=behaviorRecordMonth(r,"positive"); if(s&&m)ensure(m,s).positive++;});
  return [...byKey.values()].filter(x=>x.inf||x.susp||x.ref||x.positive).sort((a,b)=>a.monthTime-b.monthTime || (a.student.name||"").localeCompare(b.student.name||""));
}

function renderReports() {
  const rows=buildMonthlyReportRows();
  if(!rows.length){ $("#report-table").innerHTML=`<div class="empty">No reportable behavior records yet.</div>`; return; }
  const groups=[];
  rows.forEach(r=>{let g=groups.find(x=>x.key===r.monthKey);if(!g){g={key:r.monthKey,label:r.monthLabel,rows:[]};groups.push(g);}g.rows.push(r);});
  $("#report-table").innerHTML=groups.map(g=>`<div class="report-month"><h4>${escapeHtml(g.label)}</h4><table class="data-table"><thead><tr><th>Student</th><th>Grade</th><th>Class</th><th>Shift</th><th>Infractions</th><th>Suspensions</th><th>Referrals</th><th>Positive</th><th>Total</th></tr></thead><tbody>${g.rows.map(x=>`<tr><td>${escapeHtml(x.student.name)}</td><td>${escapeHtml(x.student.grade||"—")}</td><td>${escapeHtml(x.student.class||"—")}</td><td>${escapeHtml(x.student.shift||"—")}</td><td>${x.inf}</td><td>${x.susp}</td><td>${x.ref}</td><td>${x.positive}</td><td><span class="tag">${x.inf+x.susp+x.ref+x.positive}</span></td></tr>`).join("")}</tbody></table></div>`).join("");
}

function openRecordChooser() {
  modal(`<div class="modal-head"><div><h3>Add Record</h3><p>Choose the workflow you want to start.</p></div><button class="close" data-close>×</button></div><div class="quick-grid">
    <button class="quick-card" data-action="student"><strong>Add student</strong><small>Create a new profile</small></button>
    <button class="quick-card" data-action="infraction"><strong>Log infraction</strong><small>Record an incident</small></button>
    <button class="quick-card" data-action="suspension"><strong>Record suspension</strong><small>Add suspension history</small></button>
    <button class="quick-card" data-action="referral"><strong>Create referral</strong><small>Record support referral</small></button>
    <button class="quick-card" data-action="positive"><strong>Add positive behaviour</strong><small>Recognize good conduct</small></button>
    <button class="quick-card" data-action="note"><strong>Add behavior note</strong><small>Add profile information</small></button>
  </div>`);
  bindModalActions();
}

function openAction(action) {
  if(action==="student") return studentForm();
  if(action==="infraction") return recordForm("infraction");
  if(action==="suspension") return recordForm("suspension");
  if(action==="referral") return recordForm("referral");
  if(action==="positive") return recordForm("positive");
  if(action==="note") return recordForm("note");
  if(action==="report") return showPage("reports");
}

function modal(html) { $("#modal-root").innerHTML=`<div class="modal-backdrop"><div class="modal">${html}</div></div>`; $("#modal-root [data-close]")?.addEventListener("click",closeModal); }
function closeModal(){ $("#modal-root").innerHTML=""; }
function bindModalActions(){ $$("#modal-root [data-action]").forEach(b=>b.addEventListener("click",()=>{closeModal();openAction(b.dataset.action)})); }

function studentOptions() { return state.students.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(s=>`<option value="${s.id}">${escapeHtml(s.name)}${s.student_id?` — ${escapeHtml(s.student_id)}`:""}</option>`).join(""); }

function studentForm(existingId="") {
  const existing = existingId ? state.students.find(s=>s.id===existingId) : null;
  const title = existing ? "Edit Student Profile" : "Add Student";
  modal(`<div class="modal-head"><div><h3>${title}</h3><p>${existing ? "Update the student's profile information." : "Create a new student profile. Student photos are stored in the private school photo vault."}</p></div><button class="close" data-close>×</button></div>
  <form id="student-form" class="form-grid">
    <label>Student ID<input name="student_id" value="${escapeHtml(existing?.student_id||"")}" placeholder="e.g. SJH-2026-001"></label>
    <label>Full name<input name="name" value="${escapeHtml(existing?.name||"")}" required></label>
    <label>Grade<input name="grade" value="${escapeHtml(existing?.grade||"")}" placeholder="e.g. 8"></label>
    <label>Class<input name="class" value="${escapeHtml(existing?.class||"")}" placeholder="e.g. 8A"></label>
    <label>Shift<select name="shift"><option value="">Select</option><option value="1" ${existing?.shift==="1"?"selected":""}>1</option><option value="2" ${existing?.shift==="2"?"selected":""}>2</option></select></label>
    <label>Profile photo<input name="profile_photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <label>Parent/Guardian<input name="parent_name" value="${escapeHtml(existing?.parent_name||"")}"></label>
    <label>Parent telephone<input name="parent_phone" value="${escapeHtml(existing?.parent_phone||"")}"></label>
    <label class="full">Address<textarea name="address">${escapeHtml(existing?.address||"")}</textarea></label>
    <label class="full">Additional information<textarea name="additional_information">${escapeHtml(existing?.additional_information||"")}</textarea></label>
    <div class="modal-actions full"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn primary">${existing ? "Save Changes" : "Save Student"}</button></div>
  </form>`);
  $("#student-form").addEventListener("submit",async e=>{
    e.preventDefault(); const f=new FormData(e.target); const photo=f.get("profile_photo"); const d=Object.fromEntries(f.entries()); delete d.profile_photo;
    try{
      let saved;
      if(existing){ d.id=existing.id; saved=await mutate("students",d,"update"); const idx=state.students.findIndex(x=>x.id===existing.id); if(idx>=0) state.students[idx]=saved; await IDB.put("students",saved); }
      else { saved=await mutate("students",d); if(saved){ state.students.unshift(saved); await IDB.put("students",saved); } }
      if(saved && photo instanceof File && photo.size){
        if(!state.online) toast("Profile saved offline. Add the photo after reconnecting.","info");
        else {
          if(!["image/jpeg","image/png","image/webp"].includes(photo.type)) throw new Error("Photo must be JPG, PNG or WebP.");
          if(photo.size>5*1024*1024) throw new Error("Photo must be 5 MB or smaller.");
          const ext=photo.type.split("/")[1].replace("jpeg","jpg"); const path=`${saved.id}/profile.${ext}`;
          const {error:uploadError}=await sb.storage.from("student-photos").upload(path,photo,{contentType:photo.type,upsert:true}); if(uploadError) throw uploadError;
          const {data:updated,error:updateError}=await sb.from("students").update({profile_photo_path:path}).eq("id",saved.id).select().single(); if(updateError) throw updateError;
          saved=updated; const idx=state.students.findIndex(x=>x.id===saved.id); if(idx>=0) state.students[idx]=saved; await IDB.put("students",saved);
          const {data:urlData}=await sb.storage.from("student-photos").createSignedUrl(path,3600); if(urlData?.signedUrl) state.photoUrls.set(saved.id,urlData.signedUrl);
        }
      }
      closeModal(); render(); toast(state.online?"Student profile saved.":"Student profile saved offline and queued for sync.","success");
    }catch(err){toast(err.message,"error")}
  });
}

function recordForm(type, presetStudent="") {
  const configs={
    infraction:{title:"Log Infraction",table:"infractions",fields:`<label>Student<select name="student_id" required><option value="">Select student</option>${studentOptions()}</select></label><label>Date & time<input name="occurred_at" type="datetime-local" value="${new Date().toISOString().slice(0,16)}"></label><label>Infraction type<input name="infraction_type" required placeholder="e.g. Truancy"></label><label>Location<input name="location"></label><label class="full">Description<textarea name="description" required></textarea></label><label>Action taken<input name="action_taken"></label><label>Follow-up date<input name="follow_up_date" type="date"></label><label class="full"><input name="parent_contacted" type="checkbox" style="width:auto"> Parent/guardian contacted</label>`},
    suspension:{title:"Record Suspension",table:"suspensions",fields:`<label>Student<select name="student_id" required><option value="">Select student</option>${studentOptions()}</select></label><label>Days<input name="days" type="number" min="0" step="0.5"></label><label>Start<input name="start_at" type="datetime-local"></label><label>End<input name="end_at" type="datetime-local"></label><label class="full">Reason<textarea name="reason" required></textarea></label><label class="full">Return conditions<textarea name="return_conditions"></textarea></label><label class="full"><input name="parent_notified" type="checkbox" style="width:auto"> Parent/guardian notified</label>`},
    referral:{title:"Create Referral",table:"referrals",fields:`<label>Student<select name="student_id" required><option value="">Select student</option>${studentOptions()}</select></label><label>Date<input name="referred_at" type="datetime-local" value="${new Date().toISOString().slice(0,16)}"></label><label>Referral type<input name="referral_type" required placeholder="e.g. Guidance"></label><label>Destination<input name="destination" placeholder="e.g. Guidance Counsellor"></label><label class="full">Reason<textarea name="reason"></textarea></label><label class="full">Outcome<textarea name="outcome"></textarea></label><label>Follow-up date<input name="follow_up_date" type="date"></label>`},
    positive:{title:"Add Positive Behaviour",table:"positive_behaviors",fields:`<label>Student<select name="student_id" required><option value="">Select student</option>${studentOptions()}</select></label><label>Date & time<input name="recorded_at" type="datetime-local" value="${new Date().toISOString().slice(0,16)}"></label><label>Behaviour type<select name="behavior_type" required><option>Respectful Conduct</option><option>Academic Achievement</option><option>Leadership</option><option>Helping Others</option><option>Attendance / Punctuality</option><option>School Spirit</option><option>Improved Behaviour</option><option>Other</option></select></label><label>Recognition<input name="recognition" placeholder="e.g. Commendation, award, verbal praise"></label><label class="full">Description<textarea name="description" required placeholder="Describe the positive behaviour..."></textarea></label>`},
    note:{title:"Add Behavior Note",table:"behavior_notes",fields:`<label>Student<select name="student_id" required><option value="">Select student</option>${studentOptions()}</select></label><label>Category<select name="category"><option>additional</option><option>positive</option><option>intervention</option><option>parent_contact</option></select></label><label class="full">Note<textarea name="note" required></textarea></label>`}
  }[type];
  if(!state.students.length){toast("Add a student first.","error");return}
  modal(`<div class="modal-head"><div><h3>${configs.title}</h3><p>Record securely against the student profile.</p></div><button class="close" data-close>×</button></div><form id="record-form" class="form-grid">${configs.fields}<div class="modal-actions full"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn primary">Save Record</button></div></form>`);
  if(presetStudent) $("#record-form [name=student_id]").value=presetStudent;
  let recordSubmitting=false;
  $("#record-form").addEventListener("submit",async e=>{
    e.preventDefault();
    if(recordSubmitting)return;
    recordSubmitting=true;
    const form=e.target;
    const submitButton=form.querySelector('button[type="submit"]');
    if(submitButton){submitButton.disabled=true;submitButton.textContent="Saving…";}
    const f=new FormData(form);const d=Object.fromEntries(f.entries());
    if(type==="infraction"||type==="suspension") d.client_request_id=crypto.randomUUID();
    ["parent_contacted","parent_notified"].forEach(k=>{if(k in d)d[k]=f.get(k)==="on"});
    if(type==="note"){d.recorded_at=new Date().toISOString()}
    if(type==="positive"){d.recorded_at=d.recorded_at?new Date(d.recorded_at).toISOString():new Date().toISOString()}
    if(type==="infraction"||type==="referral"){d.occurred_at&&(d.occurred_at=new Date(d.occurred_at).toISOString());d.referred_at&&(d.referred_at=new Date(d.referred_at).toISOString())}
    if(type==="suspension"){d.start_at=d.start_at?new Date(d.start_at).toISOString():null;d.end_at=d.end_at?new Date(d.end_at).toISOString():null;d.days=d.days?Number(d.days):null}
    try{
      const saved=await mutate(configs.table,d);
      const key=type==="note"?"notes":(type==="positive"?"positiveBehaviors":type+"s");
      const duplicateInState=state[key].some(x=>saved?.id && x.id===saved.id);
      if(!duplicateInState){state[key].unshift(saved);await IDB.put(type==="positive"?"positive_behaviors":key,saved);}
      closeModal();render();toast(state.online?"Record saved.":"Record saved offline and queued for sync.","success")
    }catch(err){
      toast(err.message,"error");
      recordSubmitting=false;
      if(submitButton){submitButton.disabled=false;submitButton.textContent="Save Record";}
    }
  });
}

function openStudent(id) {
  const s=state.students.find(x=>x.id===id); if(!s)return;
  const inf=state.infractions.filter(x=>x.student_id===id), susp=state.suspensions.filter(x=>x.student_id===id), ref=state.referrals.filter(x=>x.student_id===id), positive=state.positiveBehaviors.filter(x=>x.student_id===id), notes=state.notes.filter(x=>x.student_id===id);
  modal(`<div class="modal-head"><div><h3>Student Profile</h3><p>Behavior and support history</p></div><button class="close" data-close>×</button></div>
    <div class="profile-head"><div class="avatar-large">${state.photoUrls.get(s.id)?`<img src="${escapeHtml(state.photoUrls.get(s.id))}" alt="">`:escapeHtml((s.name||"S").charAt(0))}</div><div><h3 style="margin:0">${escapeHtml(s.name)}</h3><p class="muted">${escapeHtml(s.student_id||"No student ID")} · Grade ${escapeHtml(s.grade||"—")} · ${escapeHtml(s.class||"—")} · ${escapeHtml(s.shift||"—")}</p></div></div>
    <div class="form-grid" style="margin-top:15px"><div><b>Address</b><div class="muted">${escapeHtml(s.address||"—")}</div></div><div><b>Parent/Guardian</b><div class="muted">${escapeHtml(s.parent_name||"—")} · ${escapeHtml(s.parent_phone||"—")}</div></div><div class="full"><b>Additional information</b><div class="muted">${escapeHtml(s.additional_information||"—")}</div></div></div>
    <div class="modal-actions"><button class="btn primary" id="edit-student-btn" type="button">✎ Edit Student</button><button class="btn secondary" data-add-record="note">＋ Note</button><button class="btn secondary" data-add-record="infraction">＋ Infraction</button><button class="btn secondary" data-add-record="suspension">＋ Suspension</button><button class="btn secondary" data-add-record="positive">＋ Positive</button><button class="btn primary" data-add-record="referral">＋ Referral</button>${state.role==="dean"?`<button class="btn danger" id="delete-student-btn" type="button">Delete Student Profile</button>`:""}</div>
    <div class="record-grid">
      <div class="record-section"><h4>Infractions (${inf.length})</h4>${inf.length?inf.map(x=>`<div class="record-item"><b>${escapeHtml(x.infraction_type)}</b><br>${escapeHtml(x.description||"")}<br><span class="muted">${fmtDate(x.occurred_at)}</span></div>`).join(""):`<div class="empty">None recorded.</div>`}</div>
      <div class="record-section"><h4>Suspensions (${susp.length})</h4>${susp.length?susp.map(x=>`<div class="record-item"><b>${escapeHtml(x.reason)}</b><br>${x.days||"—"} day(s)<br><span class="muted">${fmtDate(x.start_at)} → ${fmtDate(x.end_at)}</span></div>`).join(""):`<div class="empty">None recorded.</div>`}</div>
      <div class="record-section"><h4>Referrals (${ref.length})</h4>${ref.length?ref.map(x=>`<div class="record-item"><b>${escapeHtml(x.referral_type)}</b> · ${escapeHtml(x.destination||"")}<br>${escapeHtml(x.reason||"")}<br><span class="muted">${fmtDate(x.referred_at)}</span></div>`).join(""):`<div class="empty">None recorded.</div>`}</div>
      <div class="record-section"><h4>Positive behaviour (${positive.length})</h4>${positive.length?positive.map(x=>`<div class="record-item"><b>${escapeHtml(x.behavior_type)}</b><br>${escapeHtml(x.description||"")}<br><span class="muted">${fmtDate(x.recorded_at)} · ${escapeHtml(x.recognition||"")}</span></div>`).join(""):`<div class="empty">None recorded.</div>`}</div>
      <div class="record-section"><h4>Profile notes (${notes.length})</h4>${notes.length?notes.map(x=>`<div class="record-item"><b>${escapeHtml(x.category||"additional")}</b><br>${escapeHtml(x.note)}<br><span class="muted">${fmtDate(x.recorded_at)}</span></div>`).join(""):`<div class="empty">None recorded.</div>`}</div>
    </div>`);
  $("#edit-student-btn")?.addEventListener("click",()=>{closeModal();studentForm(id)});
  $$("#modal-root [data-add-record]").forEach(b=>b.addEventListener("click",()=>{const type=b.dataset.addRecord;closeModal();recordForm(type,id)}));
  $("#delete-student-btn")?.addEventListener("click", async()=>{
    if(state.role!=="dean") return;
    const confirmed=confirm(`Delete ${s.name}'s student profile and all linked behaviour records? This action cannot be undone.`);
    if(!confirmed) return;
    try{
      if(state.online && s.profile_photo_path){
        const {error:photoError}=await sb.storage.from("student-photos").remove([s.profile_photo_path]);
        if(photoError) console.warn("Student photo removal failed:",photoError);
      }
      await mutate("students",{id:s.id},"delete");
      state.students=state.students.filter(x=>x.id!==s.id);
      ["infractions","suspensions","referrals","positiveBehaviors","notes"].forEach(key=>{state[key]=state[key].filter(x=>x.student_id!==s.id)});
      await IDB.del("students",s.id);
      closeModal(); render();
      toast(state.online?"Student profile deleted.":"Student profile deletion queued for sync.","success");
    }catch(err){toast(err.message||"Could not delete student profile.","error")}
  });
}

function renderAudit() {
  const el=$("#audit-table");
  if(!el) return;
  if(state.role!=="dean") { el.innerHTML="<div class=\"empty\">Dean access required.</div>"; return; }
  el.innerHTML=state.audit.length?`<table class="data-table"><thead><tr><th>Date</th><th>Action</th><th>Table</th><th>Record ID</th><th>Actor</th></tr></thead><tbody>${state.audit.map(a=>{const actor=state.staff.find(u=>u.id===a.actor_id);return `<tr><td>${fmtDate(a.created_at)}</td><td><span class="tag">${escapeHtml(a.action)}</span></td><td>${escapeHtml(a.table_name)}</td><td><code>${escapeHtml(a.record_id||"—")}</code></td><td>${escapeHtml(actor?.full_name||a.actor_id||"System")}</td></tr>`}).join("")}</tbody></table>`:`<div class="empty">No audit events yet.</div>`;
}

async function loadStaff() {
  if(state.role!=="dean")return;
  try{
    const {data,error}=await sb.functions.invoke("manage-staff",{body:{action:"list"}});
    if(error)throw error;
    state.staff=data?.profiles||[];
    renderStaff();
    renderAudit();
  }catch(e){console.error(e);$("#staff-table").innerHTML=`<div class="empty danger">${escapeHtml(e.message||"Could not load staff accounts.")}</div>`}
}
function renderStaff() {
  $("#staff-table").innerHTML=state.staff.length?`<table class="data-table"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>${state.staff.map(u=>`<tr><td>${escapeHtml(u.full_name)}</td><td>${escapeHtml(ROLE_LABELS[u.role]||u.role||"Unassigned")}</td><td><span class="tag">${u.active?"Active":"Inactive"}</span></td><td>${fmtDate(u.created_at)}</td><td><button class="btn secondary" data-edit-staff="${u.id}">Edit</button> ${u.id===state.user.id?"":`<button class="btn secondary" data-delete-staff="${u.id}">Delete</button>`}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">No staff accounts found.</div>`;
  $$('[data-edit-staff]').forEach(b=>b.addEventListener('click',()=>staffEditForm(b.dataset.editStaff)));
  $$('[data-delete-staff]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm("Delete this staff login?"))return;try{const {data,error}=await sb.functions.invoke("manage-staff",{body:{action:"delete",user_id:b.dataset.deleteStaff}});if(error)throw error;if(data?.error)throw new Error(data.error);toast("Staff login deleted.","success");await loadStaff()}catch(e){toast(e.message,"error")}}));
}
function staffEditForm(userId){
  const u=state.staff.find(x=>x.id===userId) || (state.profile?.id===userId ? state.profile : null); if(!u)return;
  const self=u.id===state.user.id;
  modal(`<div class="modal-head"><div><h3>Edit User Profile</h3><p>${self?"Update your profile name.":"Dean-only staff account administration."}</p></div><button class="close" data-close>×</button></div>
  <form id="staff-edit-form" class="form-grid"><label class="full">Full name<input name="full_name" value="${escapeHtml(u.full_name||"")}" required></label>
  ${self?"":`<label>Role<select name="role"><option value="principal" ${u.role==="principal"?"selected":""}>Principal</option><option value="vice_principal" ${u.role==="vice_principal"?"selected":""}>Vice Principal</option><option value="guidance_counsellor" ${u.role==="guidance_counsellor"?"selected":""}>Guidance Counsellor</option><option value="grade_supervisor" ${u.role==="grade_supervisor"?"selected":""}>Grade Supervisor</option><option value="dean" ${u.role==="dean"?"selected":""}>Dean of Discipline</option></select></label><label>Status<select name="active"><option value="true" ${u.active?"selected":""}>Active</option><option value="false" ${!u.active?"selected":""}>Inactive</option></select></label><label class="full">New password <span class="muted">(leave blank to keep current password)</span><input name="password" type="password" minlength="8"></label>`}
  <div class="modal-actions full"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn primary">Save Changes</button></div></form>`);
  $("#staff-edit-form").addEventListener("submit",async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target).entries());try{const action=self?"self_update":"update";body.user_id=u.id;if(self){delete body.role;delete body.active;delete body.password;}if(!body.password)delete body.password;if("active" in body)body.active=body.active==="true";const {data,error}=await sb.functions.invoke("manage-staff",{body:{action,...body}});if(error)throw error;if(data?.error)throw new Error(data.error);closeModal();toast("User profile updated.","success");if(self){state.profile.full_name=body.full_name;$("#user-name").textContent=body.full_name;$("#welcome-name").textContent=body.full_name.split(" ")[0]||"Staff";$("#user-avatar").textContent=body.full_name.trim().charAt(0).toUpperCase();}else await loadStaff();}catch(err){toast(err.message||"Could not update user profile.","error")}});
}

$("#refresh-audit")?.addEventListener("click",async()=>{ try { await loadAudit(); renderAudit(); toast("Audit log refreshed.","success"); } catch(e){ toast(e.message,"error"); } });

$("#add-staff-btn")?.addEventListener("click",()=>{
  modal(`<div class="modal-head"><div><h3>Create Staff Login</h3><p>Only the Dean of Discipline can create accounts.</p></div><button class="close" data-close>×</button></div><form id="staff-form" class="form-grid">
    <label>Full name<input name="full_name" required></label><label>Email<input name="email" type="email" required></label>
    <label>Password<input name="password" type="password" minlength="8" required></label><label>Role<select name="role" required><option value="">Select role</option><option value="principal">Principal</option><option value="vice_principal">Vice Principal</option><option value="guidance_counsellor">Guidance Counsellor</option><option value="grade_supervisor">Grade Supervisor</option><option value="dean">Dean of Discipline</option></select></label>
    <div class="modal-actions full"><button class="btn secondary" type="button" data-close>Cancel</button><button class="btn primary">Create Login</button></div></form>`);
  $("#staff-form").addEventListener("submit",async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target).entries());try{const {data,error}=await sb.functions.invoke("manage-staff",{body:{action:"create",...body}});if(error)throw error;if(data?.error)throw new Error(data.error);closeModal();toast("Staff login created.","success");await loadStaff()}catch(err){toast(err.message,"error")}})
});

$("#export-csv").addEventListener("click",()=>{
  const reportRows=buildMonthlyReportRows();
  const rows=[["Month","Student ID","Student","Grade","Class","Shift","Infractions","Suspensions","Referrals","Positive Behaviour","Total Records"]];
  reportRows.forEach(x=>rows.push([x.monthLabel,x.student.student_id||"",x.student.name,x.student.grade||"",x.student.class||"",x.student.shift||"",x.inf,x.susp,x.ref,x.positive,x.inf+x.susp+x.ref+x.positive]));
  const csv=rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\r\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`st-james-monthly-behavior-report-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
});

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.error);
boot();
