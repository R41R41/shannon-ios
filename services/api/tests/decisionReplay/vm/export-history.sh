python3 - <<'PYEOF'
import sqlite3, json
DB='/home/azureuser/shannon-ios-data/shannon.sqlite'
db=sqlite3.connect('file:'+DB+'?mode=ro',uri=True,timeout=5)
def out(kind, obj): print('@@'+kind+'\t'+json.dumps(obj,ensure_ascii=False,separators=(',',':')))
for p in ('d1f3d2d4','ca976e03','ae935fa1'):
    r=db.execute("select task_id,created_at,status,updated_at,title,goal from agent_tasks where task_id like ?",(p+'%',)).fetchone()
    T=r[0]
    out('task',{'p':p,'task':list(r)})
    for seq,step,ej,ca,cs in db.execute("select sequence,step_id,entries_json,committed_at,committed_status from fca_task_history where task_id=? order by sequence",(T,)):
        out('hist',{'p':p,'seq':seq,'step':step,'at':ca,'status':cs,'entries':json.loads(ej)})
    for row in db.execute("select revision,from_sequence,through_sequence,reset_through_sequence,template_json,bootstrap_text,updated_at from fca_task_history_summaries where task_id=?",(T,)):
        out('summary',{'p':p,'rev':row[0],'from':row[1],'through':row[2],'reset':row[3],'template':row[4],'bootstrap':row[5],'at':row[6]})
    ck=db.execute("select checkpoint_json from fca_task_checkpoints where task_id=?",(T,)).fetchone()
    c=json.loads(ck[0]) if ck and ck[0] else {}
    core=((c.get('fcaToolSelection') or {}).get('core') or {}).get('tools')
    out('core',{'p':p,'tools':core})
    out('plantree',{'p':p,'tree':c.get('fcaPlanTree')})
    for oid,bid,cmd,phase,rec,ca in db.execute("select id,body_id,command_json,phase,receipt_json,created_at from fca_body_operations where task_id=? order by created_at",(T,)):
        out('op',{'p':p,'id':oid,'cmd':json.loads(cmd),'phase':phase,'receipt':json.loads(rec) if rec else None,'at':ca})
    for row in db.execute("select event_id,sequence,event_type,title,detail,occurred_at from agent_task_events where task_id=? order by sequence",(T,)):
        out('event',{'p':p,'e':list(row)})
PYEOF
