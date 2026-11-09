import assert from "node:assert/strict";
import test from "node:test";
import { createChineseApplicationMenuTemplate } from "../src/desktop/menu-template.ts";

const actions = {
  navigate: () => {},
  hide: () => {},
  quit: () => {},
  toggleQueue: () => {},
  showAbout: () => {},
};

test("application menu and queue actions use Chinese labels", () => {
  const running = createChineseApplicationMenuTemplate(
    { paused: false, criticalReason: null, available: true },
    actions,
  );
  assert.deepEqual(
    running.map((item) => item.label),
    ["文件", "任务", "查看", "帮助"],
  );
  const taskMenu = running[1].submenu as Array<Record<string, unknown>>;
  assert.equal(taskMenu[1].label, "暂停处理新任务");
  assert.equal(taskMenu[1].enabled, true);

  const paused = createChineseApplicationMenuTemplate(
    { paused: true, criticalReason: null, available: true },
    actions,
  );
  const pausedTaskMenu = paused[1].submenu as Array<Record<string, unknown>>;
  assert.equal(pausedTaskMenu[1].label, "继续处理任务");

  const critical = createChineseApplicationMenuTemplate(
    {
      paused: true,
      criticalReason: "SOURCE_CHANGED",
      available: true,
    },
    actions,
  );
  const criticalTaskMenu = critical[1].submenu as Array<Record<string, unknown>>;
  assert.equal(criticalTaskMenu[1].enabled, false);
});
