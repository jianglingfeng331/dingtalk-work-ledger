/**
 * 重试工具：失败自动重试（阶段五·同步失败重试机制）
 */
export function withRetry(fn, retries = 2, delayMs = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      Promise.resolve()
        .then(fn)
        .then(resolve)
        .catch((err) => {
          if (left <= 0) return reject(err)
          setTimeout(() => attempt(left - 1), delayMs)
        })
    }
    attempt(retries)
  })
}
