#!/usr/bin/env python3
"""Explicitly opt-in sample data. Refuses servers without DEV_AUTH."""
import json, os, uuid, urllib.request
from datetime import datetime, timedelta, timezone
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:8080')

def req(path, user=1001, data=None):
    headers = {'X-Dev-User': str(user)}
    if data is not None:
        headers.update({'Content-Type': 'application/json', 'Idempotency-Key': str(uuid.uuid4())})
    r = urllib.request.Request(BASE+'/api/'+path, headers=headers, data=json.dumps(data).encode() if data else None)
    with urllib.request.urlopen(r) as response:
        return json.load(response)

def cmd(user, kind, **data):
    return req('command', user, {'kind': kind, **data})

if not req('config')['dev_auth']:
    raise SystemExit('Refusing to seed: DEV_AUTH is disabled')
if req('state')['groups']:
    raise SystemExit('Refusing to seed: database is not empty')
cmd(1001, 'profile', name='Михаил', group_id=0)
for name in ['М8О-201Б-25', 'М8О-202Б-25']:
    cmd(1001,'group',name=name)
for name in ['Программирование', 'Математический анализ', 'Физика']:
    cmd(1001,'subject',name=name)
cmd(1001,'role',user_id=2001,enabled=True)
cmd(2001,'profile',name='Алексей Викторович',group_id=0)
for subject in range(1,4):

    for number,name in enumerate(['Основы и практика','Исследование методов','Итоговая работа'],1):
        cmd(2001,'lab',subject_id=subject,group_id=1,number=number,name=name)
for user,name in [(3001,'Михаил Соколов'),(3002,'Анна Морозова'),(3003,'Даниил Волков')]:
    cmd(user,'profile',name=name,group_id=1)
    cmd(2001,'grade',user_id=user,lab_id=1,value=4,version=0)
for offset,(name,strategy,room) in enumerate([('Лабораторные № 1–3','fifo','Г-305'),('Практикум по анализу','asc','Б-412'),('Сдача лабораторных работ','random','А-208')],1):
    starts=(datetime.now(timezone.utc)+timedelta(hours=offset)).isoformat()
    cmd(2001,'event_create',name=name,subject_id=offset,group_ids=[1],starts_at=starts,room=room,strategy=strategy,duration=10,description='Подготовьте отчёт и будьте готовы ответить на вопросы по работе.')
    cmd(2001,'event_action',event_id=offset,action='open')
    for uid in [3002,3003]:
        cmd(uid,'join',event_id=offset)
cmd(3001,'join',event_id=1)
cmd(2001,'event_action',event_id=1,action='start')
print('Demo created: root 1001, teacher 2001, students 3001–3003')
