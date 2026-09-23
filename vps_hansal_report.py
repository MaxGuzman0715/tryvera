# Run on the VPS from the tryvera folder:  python vps_hansal_report.py
import sqlite3, json, re, glob, pathlib, collections, datetime
DB = 'data/application_logs.db'
c = sqlite3.connect(DB)
rows = c.execute("select created_at, data from applications where resume_profile='hansal_maniar'").fetchall()
def week(d):
    dt = datetime.date.fromisoformat(d[:10]); return (dt - datetime.timedelta(days=dt.weekday())).isoformat()
gen = collections.Counter(week(r[0]) for r in rows)
print('HANSAL RESUMES GENERATED ON VPS, BY WEEK')
for w in sorted(gen): print('  %s  %4d' % (w, gen[w]))
print('  TOTAL %d' % sum(gen.values()))
# reasoning effort actually used, per week, from the verbose logs
eff = {}
for p in glob.glob('data/logs/verbose/app_*.log'):
    t = pathlib.Path(p).read_text(encoding='utf8', errors='replace')
    r = [int(x) for x in re.findall(r'"reasoning_tokens": (\d+)', t)]
    cost = sum(float(x) for x in re.findall(r'\n  "cost": ([\d.]+)', t))
    eff[pathlib.Path(p).stem] = (max(r) if r else 0, cost)
byweek = collections.defaultdict(lambda: [0, 0, 0.0])
for created, data in rows:
    j = json.loads(data); k = j.get('id', '')
    if k in eff:
        e = byweek[week(created)]; e[0] += 1; e[1] += eff[k][0]; e[2] += eff[k][1]
print('\nEFFORT AND COST BY WEEK (from OpenRouter usage in the logs)')
for w in sorted(byweek):
    n, r, cst = byweek[w]
    level = 'minimal' if r/n < 200 else 'low' if r/n < 3000 else 'medium' if r/n < 20000 else 'high'
    print('  %s  runs %4d  avg reasoning %6d (%s)  cost $%.2f' % (w, n, r/n, level, cst))
# fingerprints so interview PDFs can be traced back to a generation date
fp = {}
for f in glob.glob('output/*/**/result.json', recursive=True):
    try: r = json.loads(pathlib.Path(f).read_text(encoding='utf8'))
    except Exception: continue
    if r.get('resume_profile') != 'hansal_maniar': continue
    md = r.get('resume_markdown') or ''
    bl = [re.sub(r'\W+', '', l[2:])[:80] for l in md.split('\n') if l.startswith('- ')]
    if bl: fp[r.get('created_at', '')[:10] + '|' + (r.get('company_name') or '?')[:30]] = bl
pathlib.Path('hansal_fingerprints.json').write_text(json.dumps(fp), encoding='utf8')
print('\nwrote hansal_fingerprints.json (%d resumes) - send this file back' % len(fp))
