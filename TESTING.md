# Тестирование расширения BSL Analyzer

## Быстрый старт

### 1. Подготовка

Убедитесь, что LSP сервер собран:
```bash
cd ../bsl-analyzer
cargo build --release
```

Путь к бинарнику: `../bsl-analyzer/target/release/bsl-analyzer`

### 2. Запуск расширения

В VSCode:
1. Откройте папку `bsl-analyzer-vscode`
2. Нажмите **F5** (или Run → Start Debugging)
3. Откроется новое окно VSCode с активированным расширением

### 3. Тестирование функций

В новом окне VSCode:

1. **Откройте тестовый файл:**
   - File → Open Folder → выберите `test-workspace`
   - Откройте `Sample.bsl`

2. **Проверьте Semantic Highlighting:**
   - Ключевые слова должны быть выделены
   - Процедуры/Функции должны иметь особый цвет
   - Переменные, параметры отличаются визуально

3. **Тестируйте Goto Definition (F12):**
   - Поставьте курсор на `ОбработатьДанные` в строке 75 (вызов функции)
   - Нажмите F12 → должен перейти к определению процедуры

4. **Тестируйте Find References (Shift+F12):**
   - Поставьте курсор на имя функции `ВычислитьСумму`
   - Нажмите Shift+F12 → должны найтись все места использования

5. **Проверьте Diagnostics:**
   - Откройте панель Problems (Ctrl+Shift+M)
   - Должны появиться диагностики для файла (если есть проблемы)

### 4. Настройка пути к серверу

**test-workspace уже настроен** с правильным путём к серверу в `.vscode/settings.json`.

Если хотите указать конкретный путь к `bsl-analyzer` в других проектах:

1. File → Preferences → Settings (Workspace)
2. Найдите "BSL Analyzer"
3. Установите `bsl-analyzer.server.path`:
   ```
   /home/itrous/src/lsp/bsl-analyzer/target/release/bsl-analyzer
   ```

Или создайте `.vscode/settings.json` в корне workspace:
```json
{
  "bsl-analyzer.server.path": "/path/to/bsl-analyzer/target/release/bsl-analyzer"
}
```

### 5. Включение трассировки

Для отладки коммуникации с сервером:

Settings → BSL Analyzer → Trace Server → `verbose`

Логи будут в Output панели (View → Output → выберите "BSL Analyzer Language Server")

## Возможные проблемы

### "Failed to start BSL Analyzer"

1. Проверьте, что сервер собран: `ls -lh ../bsl-analyzer/target/release/bsl-analyzer`
2. Попробуйте запустить вручную: `../bsl-analyzer/target/release/bsl-analyzer`
3. Проверьте настройки пути в extension settings

### Семантическая подсветка не работает

1. Убедитесь, что файл имеет расширение `.bsl` или `.os`
2. Проверьте, что язык файла установлен как "bsl" (правый нижний угол VSCode)

### Нет диагностик

1. Проверьте файл `.bsl-analyzer.json` в корне workspace (также поддерживается `.bsl-language-server.json`)
2. Убедитесь, что diagnostics.enabled = true

## Тестовые сценарии

### Сценарий 1: Рефакторинг
1. Переименуйте параметр `Данные` → нажмите F2
2. Все использования должны обновиться (через Find References)

### Сценарий 2: Навигация
1. Создайте новую процедуру, которая вызывает `ВычислитьСумму`
2. Используйте F12 для перехода к определению
3. Используйте Alt+← для возврата назад

### Сценарий 3: Диагностики
1. Создайте пустой блок `Если ... КонецЕсли` без кода
2. Должна появиться диагностика "EmptyCodeBlock"

## Производительность

На файле из 1000+ строк:
- Первый анализ: ~100-200ms
- Инкрементальные изменения: ~10-50ms
- Память: ~50-100MB для одного файла

## Следующие шаги

После успешного тестирования:
1. Создать VSIX пакет: `npm run vscode:prepublish && vsce package`
2. Установить в VSCode: Extensions → Install from VSIX
3. Протестировать на реальном проекте
