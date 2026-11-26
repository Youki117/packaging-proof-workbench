// Shared structured rule definitions for both ordinary food (GB 7718) and pet feed (MOA labeling rules).

const compact = text => String(text ?? '').normalize('NFKC').replace(/\s+/gu, '');

export function detectProofCategory(lines) {
  const isPet = lines.some(({ text }) =>
    /宠物益生菌|宠物营养补充剂|宠物添加剂预混合饲料|补充性宠物食品|宠物饲料卫生规定|全价(?:犬|猫)粮|宠物零食/.test(compact(text)))
    || ['原料组成', '添加剂组成'].every(label => lines.some(({ text }) => compact(text).startsWith(`【${label}】`)));
  return isPet ? 'pet' : 'food';
}

export const PET_CLAIM_PATTERNS = [
  /(?:用于|有效|能够|可以|帮助)?(?:调理|缓解|改善|预防|治疗|防治|抑制|消除|修复)[^；。！？\n]{0,24}(?:软便|腹泻|拉稀|便血|呕吐|肠胃炎|肠道紊乱|肠炎|胃炎|皮肤病|皮炎|湿疹|泌尿道?感染|尿路感染|结石|口炎|耳炎|泪痕|关节炎|胰腺炎)/u,
  /(?:降低|减少|缓解)[^；。！？\n]{0,12}药物[^；。！？\n]{0,14}(?:刺激|副作用|损伤|负担)|(?:替代|取代|配合|服用)[^；。！？\n]{0,14}(?:药物|消炎药|抗生素|兽药)|好转即停|无改善[^；。！？\n]{0,10}就医|驱虫后[^；。！？\n]{0,12}(?:调理|服用)/u
];

export const FOOD_CLAIM_PATTERNS = [
  /(?:预防|治疗|治愈|根治|防治|抗癌|防癌|降血糖|降血压|降血脂|降尿酸|消炎|杀菌|抑菌|解酒|护肝|治病|疗效|药效)/u,
  /(?:增强|提高|提升)免疫力|调节肠道菌群|改善睡眠|辅助降(?:血脂|血糖|血压)|抗氧化|缓解体力疲劳|润肠通便|辅助保护(?:胃粘膜|肝损伤)|改善(?:骨密度|贫血|记忆)/u,
  /(?:国家级|最高级|最佳|第一品牌|顶级|极品|绝对有效|100%有效|彻底解决)/u
];

export const GENERAL_CLAIM_PATTERN = /治疗|治愈|根治|疗效|降血糖|降血压|增强免疫力|调节肠道菌群|(?:中国发明)?专利菌株|\d+株(?:活性)?专利菌/u;

export function matchClaimRule(compactText, category) {
  if (category === 'pet') {
    for (const pattern of PET_CLAIM_PATTERNS) {
      const hit = pattern.exec(compactText);
      if (hit) {
        return {
          title: '复核宠物功效表述',
          reason: '这段涉及动物疾病、症状或用药效果。请结合原稿、法规口径和支持材料复核宣传表述。',
          quote: hit[0]
        };
      }
    }
  } else {
    for (const [index, pattern] of FOOD_CLAIM_PATTERNS.entries()) {
      const hit = pattern.exec(compactText);
      if (hit) {
        return {
          title: index === 0 ? '复核疾病治疗或医疗宣称' : index === 1 ? '复核保健功能宣称' : '核对绝对化宣传用语',
          reason: index === 0
            ? '普通食品不得涉及疾病预防、治疗功能。请结合整面语境确认该表述是否需修改。'
            : index === 1
              ? '普通食品不宜明示或暗示保健功能。请核对产品类别及依据。'
              : '出现疑似绝对化或极限用语，请对照广告合规口径复核。',
          quote: hit[0]
        };
      }
    }
  }
  const general = GENERAL_CLAIM_PATTERN.exec(compactText);
  if (general) {
    return {
      title: '核对宣传表述与依据',
      reason: '请结合整面包装、产品类别和支持材料，判断这处表达是否需要修改。',
      quote: general[0]
    };
  }
  return null;
}

const JOINED_STATEMENT_RULES = [
  {
    petOnly: true,
    pattern: /(反刍动物)((?:产品)?(?:质量检验|合格证明|贮存条件|储存条件|保质期|净含量|生产日期|执行标准|产品标准|注意事项|温馨提示))/u
  },
  {
    petOnly: false,
    pattern: /(质量检验合格)((?:不得饲喂|贮存条件|储存条件|保质期|净含量|生产日期|执行标准|产品标准|注意事项|温馨提示))/u
  }
];

export function matchJoinedStatements(compactText, category) {
  for (const rule of JOINED_STATEMENT_RULES) {
    if (rule.petOnly && category !== 'pet') continue;
    const match = rule.pattern.exec(compactText);
    if (!match) continue;
    const [quote, left, right] = match;
    return {
      title: '核对两项标示之间的分隔',
      quote,
      reason: `识别到「${left}」与「${right}」在同一行连写且缺少分隔。请对照原稿，在「${left}」后换行，或加句号分开。`
    };
  }
  return null;
}

export const PET_PRODUCTION_FIELDS = [
  {
    title: '生产企业名称',
    pattern: /^(?:[【\[〖〔{])?(?:生产企业(?:名称)?|生产商|生产厂家|制造商|生产单位)(?:[】\]〗〕}:：]+)?[^:：]{2,70}(?:公司|工厂|厂|合作社)$/u,
    missing: '未从已识别的版面找到明确的生产企业名称。请查看完整背标，确认生产企业字段和全称。'
  },
  {
    title: '生产地址',
    pattern: /^(?:[【\[〖〔{])?生产(?:注册)?地址(?:\(注册地址\))?[】\]〗〕}:：]+.{4,}$/u,
    missing: '未从已识别的版面找到明确的生产地址。请核对背标生产企业地址及其归属。'
  },
  {
    title: '生产日期',
    pattern: /^(?:[【\[〖〔{])?生产日期(?:[】\]〗〕}:：(（年月日/]|见|\d)/u,
    missing: '未从已识别的版面找到生产日期标示。请核对喷印区是否有日期字段、格式或见某处的说明。'
  }
];

export const PET_EXTENDED_FIELDS = [
  {
    title: '净含量',
    pattern: /(?:^|[【\[〖〔{])净含量[】\]〗〕}:：]?\s*\d/u,
    missing: '未从已识别文字中定位到净含量标示，请核对主展示面与背标。'
  },
  {
    title: '保质期与贮存条件',
    pattern: /(?:^|[【\[〖〔{])(?:保质期|贮存条件|储存条件)[】\]〗〕}:：]/u,
    missing: '未识别到明确的保质期或贮存条件字段，请核对完整背标。'
  },
  {
    title: '产品标准编号',
    pattern: /(?:产品标准(?:编号|代号)?|执行标准)[】\]〗〕}:：]?.*(?:GB|NY|Q\/)/iu,
    missing: '未识别到明确的产品标准编号，请核对背标标准代号。'
  },
  {
    title: '生产许可证编号',
    pattern: /生产许可证(?:编号|号)?[】\]〗〕}:：]?.*(?:饲|SC)/u,
    missing: '未识别到生产许可证编号，请确认是否适用及标示完整。'
  },
  {
    title: '反刍动物警示',
    pattern: /不得饲喂反刍动物/u,
    missing: '未识别到「本产品不得饲喂反刍动物」警示语（含动物源性成分时通常为强制项，请核对法规适用性）。'
  },
  {
    title: '质量检验合格',
    pattern: /(?:产品)?质量检验合格|检验合格/u,
    missing: '未识别到产品质量检验合格标示，请查看完整原稿确认。'
  }
];

export const FOOD_LABEL_FIELDS = [
  {
    title: '产品名称',
    pattern: /^(?:[【\[〖〔{])?(?:产品名称|品名)[】\]〗〕}:：]+.{2,}/u,
    missing: '未在识别文本中定位到显式「产品名称/品名」字段，请核对主展示面真实属性名称。'
  },
  {
    title: '配料表',
    pattern: /^(?:[【\[〖〔{])?(?:配料(?:表)?|原辅料(?:表)?|原料(?:表)?)[】\]〗〕}:：]?/u,
    missing: '未定位到配料表标题，请查看完整原稿确认强制标示。'
  },
  {
    title: '净含量与规格',
    pattern: /(?:净含量|净重|规格)[】\]〗〕}:：]?\s*\d/u,
    missing: '未识别到净含量或规格数值，请核对主展示面及单位写法。'
  },
  {
    title: '生产企业名称',
    pattern: /^(?:[【\[〖〔{])?(?:(?:受委托)?生产(?:企业|商|者|厂家|单位)(?:名称)?|制造商)(?:[】\]〗〕}:：]+)?[^:：]{2,70}(?:公司|工厂|厂|合作社)$/u,
    missing: '未定位到明确的生产企业全称，请核对委托/受委托主体归属。'
  },
  {
    title: '生产地址与联系方式',
    pattern: /^(?:[【\[〖〔{])?(?:生产地址|地址|联系方式|联系电话|服务热线|电话)[】\]〗〕}:：]+.{4,}/u,
    missing: '未定位到生产地址或联系方式字段，请核对背标主体信息。'
  },
  {
    title: '生产日期与保质期',
    pattern: /(?:生产日期|保质期)[】\]〗〕}:：(（年月日/]|保质期至/u,
    missing: '未定位到生产日期或保质期标示，请核对喷码区指引与格式。'
  },
  {
    title: '贮存条件',
    pattern: /(?:贮存条件|储存条件|贮藏方法|保存方法)[】\]〗〕}:：]/u,
    missing: '未识别到贮存条件字段，请核对背标。'
  },
  {
    title: '产品标准代号',
    pattern: /(?:产品标准(?:代号|编号)?|执行标准)[】\]〗〕}:：]?.*(?:GB|QB|SB|DB|NY|Q\/)/iu,
    missing: '未识别到产品标准代号，请核对国标/行标/备案企标编号。'
  },
  {
    title: '食品生产许可证编号',
    pattern: /(?:食品)?生产许可证(?:编号|号)?[】\]〗〕}:：]?.*SC\d{10,}/iu,
    missing: '未识别到 SC 食品生产许可证编号，请核对背标证照信息。'
  },
  {
    title: '营养成分表',
    pattern: /营养成分表|能量.*(?:kJ|千焦)/iu,
    missing: '未识别到营养成分表，请确认是否适用豁免或核对原稿。'
  }
];
