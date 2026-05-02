/**
 * E2E entry point — bundles quickbeam-js and assigns exports to
 * globalThis.QuickbeamJs so that QuickBEAM.eval() can access them.
 *
 * When loaded via QuickBEAM.eval(rt, bundledCode):
 *   typeof QuickbeamJs !== 'undefined' // true
 *   QuickbeamJs.GenServer.startLink(...)
 */
import * as QuickbeamJs from "./index.ts";
(globalThis as any).QuickbeamJs = QuickbeamJs;
