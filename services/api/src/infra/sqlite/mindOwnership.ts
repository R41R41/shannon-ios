import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat } from 'node:fs/promises';
/** The private socket directory must already be validated. The OS releases this lock even on process death. */
export async function holdMindOwnership(path:string):Promise<()=>void> {
  try{const old=await lstat(path);if(!old.isFile()||old.isSymbolicLink()||(process.getuid && old.uid!==process.getuid()))throw new Error('MIND_IPC_LOCK');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const ownership=new DatabaseSync(path);
  try{ownership.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');}
  catch{ownership.close();throw new Error('MIND_IPC_ALREADY_RUNNING');}
  try{await chmod(path,0o600);}catch(error){ownership.close();throw error;}
  let released=false;
  return ()=>{if(!released){released=true;ownership.exec('ROLLBACK');ownership.close();}};
}
