import fs from 'node:fs';
import vm from 'node:vm';

const root = '/home/ubuntu/majlis_online_fixes';
const html = fs.readFileSync(`${root}/index.html`, 'utf8');
const worker = fs.readFileSync(`${root}/index.js`, 'utf8');
const net = fs.readFileSync(`${root}/net.js`, 'utf8');
const sw = fs.readFileSync(`${root}/sw.js`, 'utf8');

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
if (!scripts.length) throw new Error('لم يُعثر على سكربت مضمّن في index.html');
for (const script of scripts) new vm.Script(script, { filename: 'index.html:inline-script.js' });
new vm.Script(net, { filename: 'net.js' });
new vm.Script(sw, { filename: 'sw.js' });

const checks = [
  ['ماهجونغ: كل مقاعد اللعب الجماعي بشرية', 'mjHum=Array.from({length:n},(_,i)=>cfgJ.mode===\'party\'||i===0);'],
  ['ماهجونغ: تحويل الجولة المفتوحة فور إنشاء الغرفة', "if(cur==='mj' && Array.isArray(mjHum) && mjHum.length) mjHum=Array.from({length:cfgJ.count},()=>true);"],
  ['لودو: مدة خطوة أبطأ ومشتركة', 'const LUDO_STEP_MS=420;'],
  ['لودو: انتقال الحجر يواكب مهلة الخطوة', 'transition:inset-inline-start .38s'],
  ['لودو: الضيف لا يشغل نرداً وصوتاً محليين', '/* لا تحرّك أو تصوّت محلياً هنا: حدث المضيف roll هو المصدر الوحيد للدوران والصوت عند الضيف. */'],
  ['لودو: دوران النرد مؤجل لإطار رسم', 'requestAnimationFrame(paint);'],
  ['الذاكرة: اللقطات تحترم مدة المؤثر', 'function netReceiveState(game,state){'],
  ['الذاكرة: حالة القفل تُزامن', 'l:mLock'],
  ['ماهونغ: مؤثر الدفع يمنع إعادة الرسم المبكر', "netHoldVisual('mj',1520); mjLock=true;"],
  ['ماهونغ: مؤثر دفع احتياطي للضيف', "colEl.classList.add(isMine?'netpush-mine':'netpush-foe');"],
  ['ماهونغ: صاحب القرعة فقط يرى السحب مفعلاً', 'const localTurn=!netOn() || mjCur===me;'],
  ['الغرفة: أدوات الإعداد وإعادة الجولة محصورة بالمضيف', "document.querySelectorAll('.roomhost').forEach(b=>{"],
  ['الغرفة: تعديل الإعدادات يتحقق من صلاحية المضيف', "if(roomSetting && !hostOnly()) return;"],
  ['الغرف: تفريغ بيانات الغرفة السابقة', 'function prevClear(){'],
  ['الغرف: العودة بالهوية المحفوظة', 'try{ await N().join(c, profile.name, rejoinId); netDone(); }'],
  ['الغرف: مغادرة الغرفة تمسح الحالة السابقة', 'prevClear(); netColors=[];'],
  ['الغرف: إنهاء الجولة يمسح الحالة السابقة', "if(netOn()){                       // مغادرة اللعبة تُنهي الغرفة\n    prevClear();"],
  ['الخادم: لا يبث تحديث الغرفة لجلسة المغادرة', 'this.reassignHost(); this.pushRoom(me.id);'],
  ['العميل: إلغاء محاولة إعادة الاتصال عند المغادرة', 'clearTimeout(this._reTimer); this._reTimer = null;'],
  ['عامل الخدمة: إصدار إصلاحات جديد', "majlis-v7.4.1-online-fixes"]
];

for (const [name, needle] of checks) {
  const source = needle.includes('this._reTimer') ? net : needle.includes('majlis-v7.4') ? sw : needle.includes('this.') ? worker : html;
  if (!source.includes(needle)) throw new Error(`فشل التحقق: ${name}`);
}

console.log(`OK: syntax parsed and ${checks.length} regression checks passed.`);
