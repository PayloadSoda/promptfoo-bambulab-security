function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class TargetForm {
  constructor(container, onChange, onError) {
    this.container = container;
    this.onChange = onChange;
    this.onError = onError;
    container.addEventListener('input', event => { if (event.target.matches('.target-value')) onChange(); });
  }
  field(key, value, scope, optional = false) {
    const row = element('div', 'target-field');
    row.dataset.key = key; row.dataset.scope = scope; row.dataset.optional = String(optional);
    const label = element('label', '', scope === 'config' ? `config.${key}` : key);
    const type = value !== null && typeof value === 'object' || value === null ? 'json' : typeof value;
    const input = element(type === 'json' ? 'textarea' : type === 'boolean' ? 'select' : 'input', 'target-value');
    input.dataset.type = type;
    if (type === 'boolean') {
      input.append(new Option('true', 'true'), new Option('false', 'false'));
      input.value = String(value);
    } else if (type === 'json') {
      input.rows = 4; input.value = JSON.stringify(value, null, 2);
      label.append(element('span', 'field-format', 'JSON'));
    } else {
      input.type = type === 'number' ? 'number' : 'text';
      if (type === 'number') input.step = 'any';
      input.value = String(value);
    }
    input.setAttribute('aria-label', scope === 'config' ? `config.${key}` : key);
    label.append(input); row.append(label);
    if (key !== 'id' || scope === 'config') {
      const remove = element('button', 'text-button', '移除'); remove.type = 'button';
      remove.setAttribute('aria-label', `移除字段 ${scope === 'config' ? 'config.' : ''}${key}`);
      remove.addEventListener('click', () => { row.remove(); this.onChange(); });
      row.append(remove);
    }
    return row;
  }
  render(targets) {
    this.container.replaceChildren();
    targets.forEach((target, index) => {
      const card = element('div', 'target-card');
      const heading = element('div', 'target-card-heading');
      heading.append(element('strong', '', `目标 ${index + 1}`));
      const remove = element('button', 'text-button danger', '删除目标'); remove.type = 'button';
      remove.addEventListener('click', () => { card.remove(); this.onChange(); });
      heading.append(remove); card.append(heading);
      card.append(this.field('id', target.id ?? '', 'target'), this.field('label', target.label ?? '', 'target', !Object.hasOwn(target, 'label')));
      const configObject = target.config && typeof target.config === 'object' && !Array.isArray(target.config);
      for (const [key, value] of Object.entries(target)) {
        if (key !== 'id' && key !== 'label' && (key !== 'config' || !configObject)) card.append(this.field(key, value, 'target'));
      }
      const configFields = element('div', 'target-config-fields');
      configFields.dataset.present = String(Object.hasOwn(target, 'config') && !!configObject);
      for (const [key, value] of Object.entries(configObject ? target.config : {})) configFields.append(this.field(key, value, 'config'));
      card.append(configFields);
      const addRow = element('div', 'target-add-field');
      const keyInput = element('input'); keyInput.placeholder = '新 config 字段名'; keyInput.setAttribute('aria-label', '新 config 字段名');
      const typeInput = element('select'); typeInput.setAttribute('aria-label', '新 config 字段类型');
      for (const [text, value] of [['文本', 'string'], ['数字', 'number'], ['布尔', 'boolean'], ['对象 / 数组', 'json']]) typeInput.append(new Option(text, value));
      const add = element('button', 'button secondary', '添加'); add.type = 'button';
      add.addEventListener('click', () => {
        const key = keyInput.value.trim();
        if (!key) return this.onError('请填写新 config 字段名');
        if ([...configFields.children].some(row => row.dataset.key === key)) return this.onError(`config.${key} 已存在`);
        configFields.append(this.field(key, { string: '', number: 0, boolean: false, json: {} }[typeInput.value], 'config'));
        keyInput.value = ''; this.onChange();
      });
      addRow.append(keyInput, typeInput, add); card.append(addRow);
      this.container.append(card);
    });
    if (!targets.length) this.container.append(element('p', 'hint', '文件未包含目标，请添加目标或使用「覆盖配置（我的）」。'));
  }
  read() {
    return [...this.container.querySelectorAll('.target-card')].map((card, index) => {
      const fields = [], config = [];
      for (const row of card.querySelectorAll('.target-field')) {
        const input = row.querySelector('.target-value');
        let value = input.value;
        const name = `目标 ${index + 1} 的 ${row.dataset.scope === 'config' ? 'config.' : ''}${row.dataset.key}`;
        if (row.dataset.optional === 'true' && value === '') continue;
        if (input.dataset.type === 'number') {
          if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`${name} 必须是有效数字`);
          value = Number(value);
        } else if (input.dataset.type === 'boolean') value = value === 'true';
        else if (input.dataset.type === 'json') {
          try { value = JSON.parse(value); } catch { throw new Error(`${name} 的 JSON 格式不正确`); }
        }
        (row.dataset.scope === 'config' ? config : fields).push([row.dataset.key, value]);
      }
      if (config.length || card.querySelector('.target-config-fields').dataset.present === 'true') {
        if (fields.some(([key]) => key === 'config')) throw new Error('请先移除无效的 config 字段，再添加 config 参数');
        fields.push(['config', Object.fromEntries(config)]);
      }
      return Object.fromEntries(fields);
    });
  }
}
