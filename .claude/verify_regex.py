import re

p = 'docs/superpowers/specs/2026-10-09-后续交付路线图-design.md'
rm = open(p, encoding='utf-8').read()
m1 = re.search(r'~~[^~]*params[^~]*~~[^\n]*✅', rm)
m2 = re.search(r'~~[^~]*B vs A/E[^~]*~~[^\n]*✅', rm)
print('断言1(条目7) 改前命中:', bool(m1))
if m1:
    print('  片段:', repr(m1.group()[:160]))
    print('  位置:', m1.start(), '-', m1.end())
print('断言2(条目4) 改前命中:', bool(m2))
if m2:
    print('  片段:', repr(m2.group()[:160]))
    print('  位置:', m2.start(), '-', m2.end())
