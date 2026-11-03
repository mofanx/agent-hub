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
const { result } = await ctrl.call("room.list", {});
const room = result.rooms.find(r => r.name === "dp-cli") ?? result.rooms.find(r => r.name === "agent-hub");
console.log("room:", room.roomId, room.name);
const fl = await ctrl.call("room.flow", { roomId: room.roomId });
console.log("tasks:", (fl.result?.flow?.tasks ?? []).map(t=>t.id+":"+t.status).join(","));
await sub.call("client.subscribe", { tier: "detail", roomId: room.roomId, taskIds: ["t1"] });
await new Promise(r => setTimeout(r, 90000));
const tagged = (l) => l.filter(m => taskIdsOf(m.params).length > 0);
const stat = (l) => { const t = tagged(l); return { total: l.length, tagged: t.length, ids: [...new Set(t.flatMap(m=>taskIdsOf(m.params)))] }; };
console.log("SUB(t1):", JSON.stringify(stat(events.sub)));
console.log("CTRL:", JSON.stringify(stat(events.ctrl)));
const viol = tagged(events.sub).filter(m => taskIdsOf(m.params).some(id=>id!=="t1") || m.params?.roomId !== room.roomId);
console.log("SUB violations:", viol.length);
process.exit(0);
