import WebSocket from "ws";
const token = "f1d7b413dda8169149d5541f1131455a071b9a4e3b8fa3859b0b4a4a6ad08104";
const url = `ws://127.0.0.1:8787/?token=${token}`;
const events = { sub: [], ctrl: [] };
function taskIdsOf(p){ if(!p) return []; const ids=new Set(); const push=v=>{if(typeof v==="string"&&v)ids.add(v)}; push(p.taskId); const e=p.entry; if(e){push(e.taskId);push(e.meta?.taskId);if(typeof e.text==="string"&&e.text.startsWith("{")){try{const t=JSON.parse(e.text);push(t.taskId);push(t.meta?.taskId);if(Array.isArray(t.tasks))t.tasks.forEach(x=>push(x?.id))}catch{}}} return [...ids]; }
function conn(name) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  const call = (m,p) => new Promise((r) => { const i=++id; pending.set(i,r); ws.send(JSON.stringify({jsonrpc:"2.0",id:i,method:m,params:p})); });
  ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method) events[name].push(m); });
  return new Promise((res, rej) => { ws.on("open", () => res({ ws, call })); ws.on("error", rej); });
}
const ctrl = await conn("ctrl");
const sub = await conn("sub");
const rid = "738f92e7";
await sub.call("client.subscribe", { tier: "detail", roomId: rid, taskIds: ["t1"] });
await new Promise(r => setTimeout(r, 90000));
const tagged = (l) => l.filter(m => taskIdsOf(m.params).length > 0);
const show = (l) => tagged(l).map(m => ({m: m.method, ids: taskIdsOf(m.params), r: m.params?.roomId}));
console.log("SUB tagged:", JSON.stringify(show(events.sub)));
console.log("CTRL tagged:", JSON.stringify(show(events.ctrl)));
const inRoom = (l) => tagged(l).filter(m => m.params?.roomId === rid);
const viol = inRoom(events.sub).filter(m => !taskIdsOf(m.params).includes("t1"));
console.log("IN-ROOM SUB non-t1 violations:", viol.length);
console.log("IN-ROOM counts:", JSON.stringify({sub: inRoom(events.sub).length, ctrl: inRoom(events.ctrl).length}));
process.exit(0);
