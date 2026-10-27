import sys, math, pyembroidery as p
pat = p.EmbPattern()
pat.add_thread({"hex": "#CC3344"}); pat.add_thread({"hex": "#2255AA"}); pat.add_thread({"hex": "#00AA00"})
for i in range(0, 361, 5):
    a = math.radians(i); pat.add_stitch_absolute(p.STITCH, 300*math.cos(a), 200*math.sin(a))
pat.add_command(p.COLOR_CHANGE)
pat.add_stitch_absolute(p.JUMP, -350, 0)
for x in range(-350, 351, 25): pat.add_stitch_absolute(p.STITCH, x, (x % 50) - 25)
pat.add_command(p.COLOR_CHANGE)
pat.add_stitch_absolute(p.JUMP, 0, -250)
for y in range(-250, 251, 30): pat.add_stitch_absolute(p.STITCH, 0, y)
pat.add_command(p.END)
for ext in ("dst", "jef"):
    p.write(pat, f"{sys.argv[1]}/py.{ext}")
for ext in ("dst", "jef"):
    r = p.read(f"{sys.argv[1]}/py.{ext}")
    print(ext, "pyembroidery reads back: stitches", r.count_stitch_commands(p.STITCH), "colorchanges", r.count_stitch_commands(p.COLOR_CHANGE)+r.count_stitch_commands(p.STOP), "extents", r.extents())
