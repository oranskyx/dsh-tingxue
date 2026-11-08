import io

p = 'test/panel-client.test.mjs'
s = io.open(p, encoding='utf-8').read()

before = s
s = s.replace(
    "assert.deepEqual(entryIds, ['tingxue-companion', 'tingxue-agent', 'tingxue-memory'])",
    "assert.deepEqual(entryIds, ['tingxue-companion', 'tingxue-agent', 'tingxue-memory', 'tingxue-graph'])",
)
s = s.replace(
    "assert.deepEqual(mainKeys, ['tingxue-companion', 'tingxue-agent', 'tingxue-memory'])",
    "assert.deepEqual(mainKeys, ['tingxue-companion', 'tingxue-agent', 'tingxue-memory', 'tingxue-graph'])",
)
s = s.replace(
    "for (const name of ['CompanionPage', 'AgentPage', 'MemoryPage']) {",
    "for (const name of ['CompanionPage', 'AgentPage', 'MemoryPage', 'GraphPage']) {",
)
s = s.replace(
    "globalThis.__PANEL_TEST__ = { CompanionPage, AgentPage, MemoryPage, makeTr, DICT }",
    "globalThis.__PANEL_TEST__ = { CompanionPage, AgentPage, MemoryPage, GraphPage, makeTr, DICT }",
)
assert s != before, 'nothing replaced'
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('test patched')
