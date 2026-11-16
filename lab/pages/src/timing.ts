// The page's own spans and marks (User Timing). marks=0 switches them off,
// to measure what the instrumentation itself costs.
import { config } from "./config";

export const measure: (name: string, options: PerformanceMeasureOptions) => void = config.marks
  ? (name, options) => void performance.measure(name, options)
  : () => {};
export const mark: (name: string, options?: PerformanceMarkOptions) => void = config.marks
  ? (name, options) => void performance.mark(name, options)
  : () => {};
