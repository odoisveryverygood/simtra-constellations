# Run the loopback-only fixture server first; no external model calls.
import json, urllib.request, hashlib
from pathlib import Path
base='http://127.0.0.1:5188'
root=Path(__file__).resolve().parents[2]
def req(path,body=None):
    data=None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json'}),timeout=120) as r: return json.load(r)
cities=req('/cities')['cities']
out={'fixture_notice':'Deterministic offline demonstration. Census/PUMS snapshot demographics and original PWGTP weights; synthetic residents. All poll probabilities are fixed loopback fixture responses, not observed opinions or live model predictions. New questions do not change these saved outcomes.','generator':{'base':'eca0073ab0fb177824edf2d84401e427b53c57b3','backend_lane':'871274dd327c37bf8b9a208c90e754728b7b1893','seed':42,'n':256,'population':'all','method':'Local backend /simulations, /agents and /poll, with loopback model fixture returning [0.6,0.4] or [0.5,0.3,0.2] for every archetype; no external requests.'},'cities':[]}
for city in cities:
    sim=req('/simulations',{'city':city['slug'],'n':256,'seed':42,'start_datetime':'2024-11-01T08:00:00Z','tick_seconds':30,'commit_every':20})
    branch=sim['main_branch']
    agents=req('/branches/'+branch+'/agents?limit=5000')['agents']
    payload={'question':'Should the city expand public transit?','description':'A proposal to expand public transit.','framing':'belief','as_of_date':'2024-11-01','model':'gpt-4o','population':'all'}
    binary=req('/branches/'+branch+'/poll',payload)
    multi=req('/branches/'+branch+'/poll',{**payload,'question':'Which proposal should the city prioritize?','framing':'options','options':['Parks','Transit','Housing']})
    for result in [binary,multi]: result['fixture_mode']=True
    path=binary['evidence']['population_source']['local_snapshot']
    out['cities'].append({'city':city,'agents':agents,'binary':binary,'options':multi,'snapshot_sha256':hashlib.sha256((root/path).read_bytes()).hexdigest()})
    print(city['slug'],len(agents),sum(a['pums_weight'] for a in agents),flush=True)
(root/'frontend/fixtures/evidence-demo.json').write_text(json.dumps(out,separators=(',',':'))+'\n')
