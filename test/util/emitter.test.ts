import { describe, expect, it, vi } from "vitest";
import { TypedEmitter } from "../../src/util/emitter.js";

interface DemoEvents {
  ping: [n: number];
  done: [];
}

describe("TypedEmitter", () => {
  it("delivers events to on listeners", () => {
    const ee = new TypedEmitter<DemoEvents>();
    const spy = vi.fn();
    ee.on("ping", spy);
    ee.emit("ping", 7);
    expect(spy).toHaveBeenCalledWith(7);
  });

  it("once listeners fire a single time", () => {
    const ee = new TypedEmitter<DemoEvents>();
    const spy = vi.fn();
    ee.once("done", spy);
    ee.emit("done");
    ee.emit("done");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("off removes a listener", () => {
    const ee = new TypedEmitter<DemoEvents>();
    const spy = vi.fn();
    ee.on("ping", spy);
    ee.off("ping", spy);
    ee.emit("ping", 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("tracks listenerCount and removeAllListeners", () => {
    const ee = new TypedEmitter<DemoEvents>();
    ee.on("ping", () => undefined);
    ee.on("ping", () => undefined);
    expect(ee.listenerCount("ping")).toBe(2);
    ee.removeAllListeners("ping");
    expect(ee.listenerCount("ping")).toBe(0);
  });
});
