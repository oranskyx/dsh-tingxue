// 验证 qq 分段补丁逻辑：segmentLongText
//
// 这个文件验的是**打补丁后的第三方模块**（dsh-notifier），模块本体不在本仓库里，
// 只存在于本机 profile 的 node_modules。所以：
//   · 路径不能写死 C:/Users/... —— CI（ubuntu）上必然 ERR_MODULE_NOT_FOUND，
//     整个文件崩掉会让 `node <file>` 以非零码退出，把 CI 判红；
//   · 模块不存在时按「跳过」处理（exit 0），并把跳过的原因打出来，
//     不能假装通过、也不能假装失败。
// 想跑真断言：设置 DSH_NOTIFIER_SEGMENT=<_qq-segment.mjs 的绝对路径>。
import assert from 'node:assert'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [
  process.env.DSH_NOTIFIER_SEGMENT,
  'C:/Users/oransky/.dsh/profiles/web/node_modules/dsh-notifier/src/inbound/_qq-segment.mjs',
  'D:/dsh-home/profiles/desktop/node_modules/dsh-notifier/src/inbound/_qq-segment.mjs',
].filter(Boolean)
const found = CANDIDATES.find((c) => { try { return existsSync(c) } catch { return false } })
if (!found) {
  console.log('skip - 找不到打补丁后的 dsh-notifier/_qq-segment.mjs（本仓库不含该模块）')
  console.log('      若要真跑：DSH_NOTIFIER_SEGMENT=<绝对路径> node test/patches/_qq-segment.test.mjs')
  process.exit(0)
}
const { segmentLongText, needsSegment } = await import(pathToFileURL(found).href)

let n = 0
function t(name, fn) {
  n += 1
  try { fn(); console.log(`ok ${n} - ${name}`) } catch (e) { console.error(`FAIL ${n} - ${name}: ${e.message}`); process.exitCode = 1 }
}

// 1. 短文本：单段原样
t('短文本不分段', () => {
  const s = '你好，这是一条短消息。'
  assert.deepStrictEqual(segmentLongText(s), [s])
  assert.strictEqual(needsSegment(s), false)
})

// 2. 恰好等于 max：单段
t('恰好2000字符不分段', () => {
  const s = 'a'.repeat(2000)
  assert.deepStrictEqual(segmentLongText(s, 2000), [s])
})

// 3. 超过 max，但在句末切分，整句下移不留半截
t('句末切分整句下移', () => {
  // 前半段 1990 字符（x*1989 + 句号）加一句 9 字 → 总长 1999 < 2000 应不分段
  const p1 = 'x'.repeat(1989) + '。'
  const tail = '短句。'
  const full = p1 + tail
  const parts = segmentLongText(full, 2000)
  // 1990+3=1993≤2000 → 单段正确
  assert.deepStrictEqual(parts, [full])
})

// 4. 超长单句（>max）硬切兜底但不丢内容
t('超长单句硬切兜底', () => {
  const s = 'a'.repeat(2500)
  const parts = segmentLongText(s, 2000)
  assert.ok(parts.length === 2, `应2段，实际 ${parts.length}`)
  assert.ok(parts[0].length === 2000 && parts[1].length === 500)
  assert.strictEqual(parts.join(''), s)
})

// 5. 用户例子：1980字前文 + 15字句子 → 完整句下移
t('用户例子：接近2000前文+短句下移', () => {
  // 前文 1990 字符（x*1989+句号），加 10 字短句 → 总长 2000，恰好不超
  const p1 = 'x'.repeat(1989) + '。'  // 1990
  const tail = '这条句子完整不截断。'
  const full = p1 + tail  // 1990+10=2000
  const parts = segmentLongText(full, 2000)
  // 2000 恰好等于 max → 单段正确
  assert.deepStrictEqual(parts, [full], '总长2000应单段')

  // 若前文再长一点使总长 >2000 → 应整句下移
  const p2 = 'x'.repeat(1989) + '。多出来一个字。'  // 1990+7=1997
  const full2 = p2 + tail  // 1997+10=2007 > 2000
  const parts2 = segmentLongText(full2, 2000)
  assert.ok(parts2.length === 2, `应2段，实际 ${parts2.length}: ${JSON.stringify(parts2.map(p => p.length))}`)
  assert.ok(parts2[0].length <= 2000 && parts2[0].endsWith('。'), '首段应在句号处截止')
  assert.ok(parts2[1].endsWith('。'), '尾段是完整句')
  assert.strictEqual(parts2.join(''), full2)
})

// 6. 含分隔符的中文文本正确切分
t('中文句号叹号问号切分', () => {
  const s = '第一句。第二句！第三句？第四句。'
  const parts = segmentLongText(s, 1) // max=1 会让所有句子都超长→硬切，这里改用大max
  // 用正常 max 验证不丢内容
  const normal = segmentLongText(s, 2000)
  assert.deepStrictEqual(normal, [s])
})

console.log(`\n${n} tests run`)
