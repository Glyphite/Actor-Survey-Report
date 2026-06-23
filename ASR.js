// ==UserScript==
// @name         扮演者调查报告规则
// @author       Glyphite
// @version      2.5.0
// @description  ActorSurveyReport专用插件，6面骰系统。
// @homepageURL https://glyphite.github.io/Actor-Survey-Report/
// @timestamp    1782259200
// @license      MIT
// ==/UserScript==

const ALIAS = { '斩击': '斩击技法', '刺击': '刺击技法', '钝击': '钝击技法', '近战': '近身搏击', '远攻': '离手遥击', '点射': '枪火轰鸣', '连射': '弹雨交织', '奇械': '奇械专精' };

function getCardField(ctx, name) {
    const raw = seal.format(ctx, '{' + name + '}');
    if (raw === undefined || raw === null || raw === '') return null;
    const v = parseInt(raw);
    return isNaN(v) ? null : v;
}

function setCardField(ctx, name, val) {
    seal.vars.intSet(ctx, name, val);
}

function calc(expr) {
    const tokens = expr.match(/\d+|[+\-*/()]/g) || [];
    const out = [], ops = [], prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const apply = () => { const b = out.pop(), a = out.pop(), op = ops.pop(); out.push({ '+': a + b, '-': a - b, '*': a * b, '/': a / b }[op]); };
    for (const t of tokens) {
        if (/\d+/.test(t)) out.push(parseInt(t));
        else if (t === '(') ops.push(t);
        else if (t === ')') { while (ops[ops.length - 1] !== '(') apply(); ops.pop(); }
        else { while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t]) apply(); ops.push(t); }
    }
    while (ops.length) apply();
    return out[0] || 0;
}

function parseDiceCount(ctx, input) {
    if (!input) return null;
    if (/^\d+$/.test(input)) return parseInt(input);
    if (/[+\-*/()（）]/.test(input)) {
        const toks = input.replace(/（/g, '(').replace(/）/g, ')').split(/([+\-*/()])/).filter(Boolean);
        let expr = '', hasVar = false;
        for (const t of toks) {
            if (/^[+\-*/()]$/.test(t)) expr += t;
            else if (/^\d+$/.test(t)) expr += t;
            else {
                const realName = ALIAS[t] || t;
                const v = getCardField(ctx, realName);
                if (v === null) return null;
                expr += v;
                hasVar = true;
            }
        }
        if (!expr) return null;
        const result = calc(expr);
        return Number.isFinite(result) ? Math.floor(result) : null;
    }
    const realName = ALIAS[input] || input;
    return getCardField(ctx, realName);
}

function greedyGroup(rolls, threshold) {
    const sorted = rolls.slice().sort((a, b) => b - a);
    const used = new Array(sorted.length).fill(false);
    const succ = [], waste = [];
    for (let i = 0; i < sorted.length; i++) {
        if (used[i]) continue;
        const group = [sorted[i]];
        used[i] = true;
        let sum = sorted[i], j = sorted.length - 1;
        while (sum < threshold && j >= 0) {
            while (j >= 0 && used[j]) j--;
            if (j < 0) break;
            used[j] = true;
            group.push(sorted[j]);
            sum += sorted[j];
            j--;
        }
        (sum >= threshold ? succ : waste).push(group);
    }
    return { success: succ.length, succ, waste };
}

function compareDominance(arr1, arr2) {
    if (arr1.length === 0 && arr2.length === 0) return 0;
    if (arr1.length === 0) return -1;
    if (arr2.length === 0) return 1;
    const s1 = arr1.slice().sort((a,b)=>a-b);
    const s2 = arr2.slice().sort((a,b)=>a-b);
    const minLen = Math.min(s1.length, s2.length);
    for (let i = 0; i < minLen; i++) {
        if (s1[i] < s2[i]) return 1;
        if (s1[i] > s2[i]) return -1;
    }
    if (s1.length > s2.length) return 1;
    if (s1.length < s2.length) return -1;
    return 0;
}

if (!seal.ext.find('asr')) {
    const ext = seal.ext.new('asr', 'admin', '2.5.0');
    const cmdAsr = seal.ext.newCmdItemInfo();
    cmdAsr.name = 'asr';
    cmdAsr.help = 'ASR扮演者调查报告：.asr help 查看规则';

    cmdAsr.solve = function(ctx, msg, cmdArgs) {
        const arg1 = cmdArgs.getArgN(1);
        const arg2 = cmdArgs.getArgN(2);
        if (!arg1 || arg1 === 'help') {
            seal.replyToSender(ctx, msg,
                '【ASR 扮演者调查报告 v2.5】\n' +
                '■ 力竭/魂/魄 请用 .st 初始化（如 .st 力竭 0）\n' +
                '■ 强化：秩序骰 ≥6 → 阈值15（计2成功）；10仍计1成功\n' +
                '■ 免疫残缺：秩序骰 ≥8 → 1不扣成功\n' +
                '■ 主导效果自动生效：秩序-1力竭 / 力竭+1力竭 / 疯狂-1魂\n' +
                '■ 所有修改直接写入 .st 角色卡字段，可用 .st show 查看\n' +
                '■ 当骰子过多时自动省略显示，不影响计算\n' +
                '指令格式:\n' +
                '.asr <数量> [疯狂] [!]\n' +
                '.asr <技能/属性> [疯狂] [!]\n' +
                '例: .asr 6   .asr 6 3!   .asr 力量 2'
            );
            return seal.ext.newCmdExecuteResult(true);
        }

        // ── 解析力竭标记和疯狂骰 ──────────────────────────
        let activeLij = false;
        let mainStr = arg1;
        let crazyStr = arg2 || '';
        if (arg2) {
            activeLij = /[!！]$/.test(arg2);
            crazyStr = arg2.replace(/[!！]/g, '');
            mainStr = arg1.replace(/[!！]/g, '');
        } else {
            activeLij = /[!！]$/.test(arg1);
            mainStr = arg1.replace(/[!！]$/, '');
        }
        const crazyDice = /^\d+$/.test(crazyStr) ? parseInt(crazyStr) : 0;

        // ── 检查角色卡字段是否初始化 ───────────────────────
        const lijInit = getCardField(ctx, '力竭');
        if (lijInit === null) {
            seal.replyToSender(ctx, msg,
                '【ASR】未检测到角色卡字段「力竭」。\n' +
                '请先使用 .st 力竭 0 初始化。'
            );
            return seal.ext.newCmdExecuteResult(true);
        }
        let lijCount = lijInit;

        // ── 解析秩序骰数量 ─────────────────────────────────
        const count = parseDiceCount(ctx, mainStr);
        if (count === null || count < 0) {
            seal.replyToSender(ctx, msg, '无效的秩序骰数量：「' + mainStr + '」');
            return seal.ext.newCmdExecuteResult(true);
        }

        // ── 力竭计算（主动部分） ───────────────────────────
        const newLijVal = activeLij ? lijCount + 1 : lijCount;
        if (activeLij) setCardField(ctx, '力竭', newLijVal);
        const liDice = activeLij ? newLijVal * 2 : lijCount;
        const totalDice = count + liDice + crazyDice;
        if (totalDice > 100) {
            seal.replyToSender(ctx, msg, '一次最多掷100颗骰子');
            return seal.ext.newCmdExecuteResult(true);
        }

        // ── 掷骰 ───────────────────────────────────────────
        const rolls = [], chainInfo = [];
        let round = 0, cur = totalDice;
        while (cur > 0 && round < 20) {
            const rnds = [];
            let addSum = 0;
            for (let i = 0; i < cur; i++) {
                const r = Math.floor(Math.random() * 6) + 1;
                rolls.push(r); rnds.push(r);
                if (r === 6) addSum++;
            }
            if (round === 0) {
                chainInfo.push({
                    order:  rnds.slice(0, count),
                    lij:    rnds.slice(count, count + liDice),
                    crazy:  rnds.slice(count + liDice)
                });
            } else {
                chainInfo.push({ rolls: rnds });
            }
            if (addSum === 0) break;
            cur = addSum;
            round++;
        }

        const isEnhanced = count >= 6;
        const noMaim     = count >= 8;

        // ── 分组 ───────────────────────────────────────────
        let grpHigh = null, grpLow = null, displaySucc, totalSuccess;
        if (isEnhanced) {
            grpHigh = greedyGroup(rolls, 15);
            const remainRolls = [].concat(...grpHigh.waste.map(g => g));
            grpLow = greedyGroup(remainRolls, 10);
            displaySucc  = [...grpHigh.succ, ...grpLow.succ];
            totalSuccess = grpHigh.success * 2 + grpLow.success;
        } else {
            const grp = greedyGroup(rolls, 10);
            displaySucc  = grp.succ;
            totalSuccess = grp.success;
        }

        const penalty  = noMaim ? 0 : rolls.filter(r => r === 1).length;
        const finalRes = totalSuccess - penalty;

        // ── 主导骰池判断（仅第一轮，不含追加） ──────────────
        const orderRolls = chainInfo[0].order;
        const lijRolls  = chainInfo[0].lij;
        const crzRolls  = chainInfo[0].crazy;

        let dominantType = null;
        let cmp = compareDominance(orderRolls, lijRolls);
        if (cmp >= 0) {
            cmp = compareDominance(orderRolls, crzRolls);
            dominantType = cmp >= 0 ? '秩序' : '疯狂';
        } else {
            cmp = compareDominance(lijRolls, crzRolls);
            dominantType = cmp >= 0 ? '力竭' : '疯狂';
        }

        // ── 主导效果自动生效（记录变化前后） ────────────────
        let domBefore = null, domAfter = null;
        if (dominantType === '秩序') {
            const cur = getCardField(ctx, '力竭');
            domBefore = cur;
            const next = Math.max(0, (cur || 0) - 1);
            setCardField(ctx, '力竭', next);
            domAfter = next;
        } else if (dominantType === '力竭') {
            const cur = getCardField(ctx, '力竭');
            domBefore = cur;
            const next = (cur || 0) + 1;
            setCardField(ctx, '力竭', next);
            domAfter = next;
        } else if (dominantType === '疯狂') {
            const cur = getCardField(ctx, '魂');
            domBefore = cur;
            const next = Math.max(1, (cur || 5) - 1);
            setCardField(ctx, '魂', next);
            domAfter = next;
        }

        // ── 省略辅助函数 ────────────────────────────────────
        const MAX_LINE_LEN = 120; // 每行最大字符数，防止分段
        function truncate(str) {
            if (str.length > MAX_LINE_LEN) {
                return str.substring(0, MAX_LINE_LEN - 3) + '...';
            }
            return str;
        }

        // ── 输出 ────────────────────────────────────────────
        const lines = [];
        if (count > 0) {
            let orderText = '秩序：{' + chainInfo[0].order.join(', ') + '}';
            lines.push(truncate(orderText));
        }
        if (liDice > 0) {
            let lijText = '力竭：{' + chainInfo[0].lij.join(', ') + '}';
            lines.push(truncate(lijText));
        }
        if (crazyDice > 0) {
            let crazyText = '疯狂：{' + chainInfo[0].crazy.join(', ') + '}';
            lines.push(truncate(crazyText));
        }

        // 追加行（单独行）
        if (chainInfo.length > 1) {
            lines.push('');
            for (let i = 1; i < chainInfo.length; i++) {
                let appendText = '追加：[' + chainInfo[i].rolls.join(', ') + ']';
                lines.push(truncate(appendText));
            }
        }

        // 组合行
        const comboParts = [];
        if (isEnhanced) {
            grpHigh.succ.forEach(g => comboParts.push(g.join('+') + '≥15'));
            grpLow.succ.forEach(g => comboParts.push(g.join('+') + '≥10'));
        } else {
            displaySucc.forEach(g => comboParts.push(g.join('+') + '≥10'));
        }
        let comboText = '组合：' + comboParts.join('、');
        lines.push('');
        lines.push(truncate(comboText));

        // 共计行
        let totalText = '共计：' + (isEnhanced
            ? '(' + grpHigh.success + '×2)+(' + grpLow.success + '×1)-' + penalty + '=' + finalRes
            : totalSuccess + '-' + penalty + '=' + finalRes);
        lines.push(truncate(totalText));

        // ── 结算行（合并主动力竭、主导、警告） ──────────────
        const settleParts = [];
        if (activeLij) {
            settleParts.push('主动力竭，当前力竭值为' + lijCount + '→' + newLijVal);
        }
        if (dominantType === '秩序' || dominantType === '力竭') {
            settleParts.push(dominantType + '主导，当前力竭值为' + domBefore + '→' + domAfter);
        } else if (dominantType === '疯狂') {
            settleParts.push('疯狂主导，当前魂值为' + (domBefore ?? '?') + '→' + domAfter);
        }
        // 警告基于最终力竭值
        const finalLij = getCardField(ctx, '力竭') || 0;
        if (finalLij >= 5) {
            settleParts.push(finalLij >= 6 ? '警告！你已经濒临崩溃！' : '警告！你承受着巨大压力');
        }
        if (settleParts.length > 0) {
            let settleText = '结算：' + settleParts.join('；');
            lines.push(truncate(settleText));
        }

        seal.replyToSender(ctx, msg, lines.join('\n'));
        return seal.ext.newCmdExecuteResult(true);
    };

    ext.cmdMap['asr'] = cmdAsr;
    ext.cmdMap['检定']   = cmdAsr;
    seal.ext.register(ext);
}