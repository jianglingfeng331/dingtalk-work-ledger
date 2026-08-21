import { v4 as uuid } from 'uuid'

/**
 * 会话服务：token → 用户（内存存储，重启失效即重新免登，轻量工具够用）
 */
const sessions = new Map() // token -> { userId, name, source }

export function createSession(user) {
  const token = uuid().replaceAll('-', '')
  sessions.set(token, user)
  return { token, user }
}

export function getUserByToken(token) {
  return sessions.get(token) || null
}
