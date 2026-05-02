with open('app/api/casino/callback/route.ts', 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines: {len(lines)}")

# Find the bot section boundaries
start_line = None
end_line = None
for i, line in enumerate(lines):
    if ('// SLOTEGRATOR BOT DYNAMIC' in line or '// SLOTGEGRATOR BOT DYNAMIC' in line) and start_line is None:
        start_line = i
    if start_line is not None and i > start_line + 5:
        if 'const params: CallbackParams' in line:
            end_line = i
            break

print(f"Bot section: lines {start_line+1} to {end_line} (0-indexed {start_line} to {end_line-1})")
print("=== CURRENT BOT SECTION ===")
for i in range(start_line, end_line):
    print(f"{i+1}: {lines[i]}", end='')
print("=== END OF BOT SECTION ===")
print(f"Line {end_line+1}: {lines[end_line]}", end='')
