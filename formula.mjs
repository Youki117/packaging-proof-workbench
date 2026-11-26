import { cfu } from './cfu.mjs';

export function formulaCfuRows(text) {
  const rows = [];
  let columns;
  let sheet;
  for (const line of text.split('\n')) {
    if (line.startsWith('Sheet: ')) {
      sheet = line.slice(7);
      columns = undefined;
      continue;
    }
    const cells = line.split('\t').flatMap(value => {
      const match = /^([A-Z]+)(\d+)=(.*)$/u.exec(value);
      return match ? [{ column: match[1], row: Number(match[2]), value: match[3].replace(/\s+/g, '') }] : [];
    });
    const heading = cells.findIndex((cell, index) => index > 0
      && /^(?:(?:每(?:克|千克))?活菌数[（(]?)?(?:\d+(?:\.\d+)?)?(?:[亿万](?:CFU)?|CFU)\/(?:kg|g|千克|克)[)）]?$/i.test(cell.value)
      && /名称|菌种|微生物|标准|企标/.test(cells[index - 1].value));
    if (heading >= 0) {
      const [name, count] = cells.slice(heading - 1, heading + 1);
      const unit = /(?:[亿万](?:CFU)?|CFU)\/(?:kg|g|千克|克)/i.exec(count.value)[0];
      columns = { name: name.column, count: count.column, row: count.row, unit };
      continue;
    }
    if (!columns) continue;
    const name = cells.find(cell => cell.column === columns.name);
    const count = cells.find(cell => cell.column === columns.count);
    if (!name || name.row !== columns.row + 1 || !/菌|酵母/.test(name.value) || /^(?:合计|总计|备注)/.test(name.value)) {
      columns = undefined;
      continue;
    }
    columns.row = name.row;
    const perGram = count?.value ? cfu(count.value, columns.unit) : null;
    rows.push({ name: name.value, perGram, cell: `${sheet}!${columns.count}${name.row}` });
  }
  if (!rows.length) throw Error('配方表未找到带明确 CFU/g、CFU/kg 或亿/g 单位的菌种明细。请核对工作表中的菌种和活菌数列。');
  return rows;
}

export function formulaIngredientRows(text) {
  const rows = [];
  const seen = new Set();
  let columns;
  let sheet = 'Sheet1';
  for (const line of text.split('\n')) {
    if (line.startsWith('Sheet: ')) {
      sheet = line.slice(7);
      columns = undefined;
      continue;
    }
    const cells = line.split('\t').flatMap(value => {
      const match = /^([A-Z]+)(\d+)=(.*)$/u.exec(value);
      return match ? [{ column: match[1], row: Number(match[2]), value: match[3].trim() }] : [];
    });
    const nameHeading = cells.find(cell =>
      /^(?:原辅?料|配料|原料|添加剂|成分|物料)(?:名称)?$|^品名$/u.test(cell.value.replace(/\s+/g, '')));
    if (nameHeading) {
      const amountHeading = cells.find(cell => cell !== nameHeading
        && /(?:占比|比例|配比|添加量|用量|含量|%|％|g\/|mg\/)/iu.test(cell.value));
      columns = { name: nameHeading.column, amount: amountHeading?.column, row: nameHeading.row };
      continue;
    }
    if (!columns) continue;
    const nameCell = cells.find(cell => cell.column === columns.name);
    if (!nameCell || nameCell.row !== columns.row + 1) {
      columns = undefined;
      continue;
    }
    const cleaned = nameCell.value.replace(/\s+/g, '');
    if (!cleaned || cleaned.length > 40 || /^(?:合计|总计|小计|备注|说明|企标|序号|\d+(?:\.\d+)?%?)$/u.test(cleaned)) {
      columns = undefined;
      continue;
    }
    columns.row = nameCell.row;
    const amountCell = columns.amount ? cells.find(cell => cell.column === columns.amount) : undefined;
    const key = cleaned.normalize('NFKC').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      rows.push({
        name: cleaned,
        amount: amountCell?.value ?? '',
        cell: `${sheet}!${columns.name}${nameCell.row}`
      });
    }
  }
  return rows;
}

export function formulaImageCfuRows(lines) {
  const cells = lines.map(({ text, box: [x, y, width, height] }) => ({
    text: text.normalize('NFKC').replace(/\s+/gu, ''), x, y: y + height / 2, right: x + width, width, height
  }));
  const headings = cells.filter(cell => /^\d+(?:\.\d+)?[亿万](?:CFU)?\/(?:g|克)$/i.test(cell.text));
  const sameRow = (a, b) => Math.abs(a.y - b.y) <= Math.min(a.height, b.height) * .55;
  const inColumn = (cell, heading) => cell.right >= heading.right - heading.width * .35
    && cell.right <= heading.right + heading.width * .65;
  const sameAmount = (a, b) => Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
  for (const heading of headings) {
    const marker = cells.find(cell => cell.right < heading.x && sameRow(cell, heading)
      && /^(?:企标[\w-]+|(?:菌种|微生物)(?:名称|明细)?|活菌(?:数|明细))$/u.test(cell.text));
    if (!marker) continue;
    const bag = cells.find(cell => cell.x > heading.x && sameRow(cell, heading) && /^\d+(?:\.\d+)?[亿万](?:CFU)?\/(?:袋|条|支)$/iu.test(cell.text));
    const unit = /[亿万](?:CFU)?\/(?:g|克)/i.exec(heading.text)[0];
    const writtenTotal = cfu(heading.text.slice(0, -unit.length), unit);
    const bagUnit = bag ? /[亿万]/u.exec(bag.text)[0] + '/g' : '';
    const bagTotal = bag ? cfu(bag.text.split(/[亿万]/u)[0], bagUnit) : null;
    const names = cells.filter(cell => cell.y > heading.y + heading.height * .5 && cell.right < heading.right
      && Math.abs(cell.x - marker.x) < heading.width
      && /^[\p{Script=Han}]{2,24}(?:[A-Za-z][\w.-]*\d[\w.-]*)?$/u.test(cell.text)
      && /菌|酵母/.test(cell.text)).sort((a, b) => a.y - b.y);
    const rows = [];
    let last = heading;
    let bagChecks = 0;
    for (const name of names) {
      if (name.y - last.y > Math.max(name.height, last.height) * 1.8) break;
      const row = cells.filter(cell => cell.x > name.right && sameRow(cell, name) && /^\d+(?:\.\d+)?$/.test(cell.text));
      const perGramCells = row.filter(cell => inColumn(cell, heading));
      if (perGramCells.length !== 1) break;
      const perGram = cfu(perGramCells[0].text, unit);
      if (!(perGram > 0)) break;
      const bagCells = bag ? row.filter(cell => inColumn(cell, bag)) : [];
      if (bagCells.length) {
        if (bagCells.length !== 1 || !sameAmount(cfu(bagCells[0].text, bagUnit), perGram * (bagTotal / writtenTotal))) break;
        bagChecks += 1;
      }
      rows.push({ name: name.text, perGram, cell: `活菌明细第 ${rows.length + 1} 行（图片 OCR）`, image: true });
      last = name;
    }
    if (rows.length >= 2 && rows.length === names.length && (!bag || bagChecks >= Math.ceil(rows.length / 2))
      && new Set(rows.map(row => row.name.toLowerCase())).size === rows.length
      && sameAmount(rows.reduce((total, row) => total + row.perGram, 0), writtenTotal)) return rows;
  }
  throw Error('图片配方表的每克列或合计无法可靠核验。请使用清晰完整的截图或原始 XLSX。');
}
