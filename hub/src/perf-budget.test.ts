import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { readTextFileRange, sliceTextFile } from "./agent.js";
import { RoomManager, type Room } from "./room.js";

/** perf 预算断言基线：所有阈值对应当轮已修项的可计数回归信号 */
const BUDGET = {
  /** 大文件区间读返回字节上限（整文件读会返回 ~1.6MB） */
  rangeReadCharsMax: 32 * 1024,
  /** room_events 增量读取上限 */
  roomEventsSinceMax: 11,
  /** 水印回放后黑板无重复条目 */
  replayBoardSize: 3,
};

describe("perf budget baseline", () => {
  it("readTextFileRange：大文件区间读有界且与 sliceTextFile 语义一致", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-range-"));
    try {
      const f = path.join(dir, "big.log");
      const lines = Array.from({ length: 20000 }, (_, i) => `line-${i}-${"x".repeat(40)}`);
      fs.writeFileSync(f, lines.join("\n"));
      const out = readTextFileRange(f, 9000, 100);
      assert.equal(out, sliceTextFile(lines.join("\n"), 9000, 100));
      assert.ok(
        out.length <= BUDGET.rangeReadCharsMax,
        `range read ${out.length} chars exceeds budget`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getRoomEvents：since 水位只回增量", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-ev-"));
    const store = new Store(dir);
    try {
      for (let i = 0; i < 50; i++) {
        store.appendRoomEvent("r1", "note", { id: `e${i}`, text: "t" });
      }
      assert.equal(store.getRoomEvents("r1").length, 50);
      const inc = store.getRoomEvents("r1", 40);
      assert.ok(inc.length <= BUDGET.roomEventsSinceMax);
      assert.equal(inc.at(-1)!.seq, 50);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eventSeq 水位：import 不重复回放、旧快照只补增量", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-wm-"));
    const store = new Store(dir);
    try {
      const r1 = new RoomManager();
      r1.setStore(store);
      const room = r1.create("t", [{ sessionId: "s1", name: "a" }]);
      for (const t of ["n1", "n2", "n3"]) r1.recordOutput(room.roomId, "s1", "a", t);
      assert.equal(room.eventSeq, 3);

      // 新快照导入：水位内事件零回放，黑板不重复
      const r2 = new RoomManager();
      r2.setStore(store);
      r2.import(JSON.parse(JSON.stringify(room)) as Room);
      assert.equal(r2.getBlackboard(room.roomId).length, BUDGET.replayBoardSize);
      assert.equal(r2.get(room.roomId)?.eventSeq, 3);

      // 旧快照（水位停在 2）导入：只补 n3 一条增量
      const stale = JSON.parse(JSON.stringify(room)) as Room;
      stale.eventSeq = 2;
      stale.blackboard = stale.blackboard?.slice(0, 2);
      const r3 = new RoomManager();
      r3.setStore(store);
      r3.import(stale);
      assert.equal(r3.getBlackboard(room.roomId).length, BUDGET.replayBoardSize);
      assert.equal(r3.get(room.roomId)?.eventSeq, 3);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
