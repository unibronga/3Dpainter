# Сверка GLB после 3DPainter в Blender: клипы, скелет, материал, покраска.
# Запускается из glb-roundtrip.cjs:
#   Blender -b --factory-startup -P tests/blender-check.py -- файл.glb
# Пишет строки «  ok …» / «  FAIL …», код выхода 1 при провале.

import sys
import bpy

args = sys.argv[sys.argv.index('--') + 1:]
path = args[0]
# --variants A,B,C — файл с вариантами покраски: сверяются они, а не «Leaf».
variants = args[args.index('--variants') + 1].split(',') if '--variants' in args else None
# --clips Имя:сек,… — какие клипы ждать (по умолчанию стебель: Sway и Bend);
# --materials A,B — какие материалы ждать; у «Face» должна быть карта.
clips_arg = args[args.index('--clips') + 1] if '--clips' in args else 'Sway:1.0417,Bend:2.0417'
wanted = {c.split(':')[0]: float(c.split(':')[1]) for c in clips_arg.split(',')}
materials = args[args.index('--materials') + 1].split(',') if '--materials' in args else None
fails = []


def check(cond, what):
    print(('  ok ' if cond else '  FAIL') + ' ' + what)
    if not cond:
        fails.append(what)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
scene = bpy.context.scene
fps = scene.render.fps / scene.render.fps_base

rigs = [o for o in scene.objects if o.type == 'ARMATURE']
meshes = [o for o in scene.objects if o.type == 'MESH']
check(len(rigs) == 1 and len(rigs[0].data.bones) == 2, f'арматура с двумя костями ({[len(r.data.bones) for r in rigs]})')
mesh = next((o for o in meshes if any(m.type == 'ARMATURE' for m in o.modifiers)), meshes[0] if meshes else None)
check(mesh is not None and any(m.type == 'ARMATURE' for m in mesh.modifiers), 'меш привязан к арматуре')

# Импортёр называет действия по имени анимации; может добавить имя объекта.
for name, dur in wanted.items():
    act = next((a for a in bpy.data.actions if a.name == name or a.name.startswith(name + '_')), None)
    check(act is not None, f'клип «{name}» есть ({[a.name for a in bpy.data.actions]})')
    if not act:
        continue
    # Время glTF ложится на кадр t·fps: длительность клипа — его последний кадр.
    start, end = act.frame_range
    seconds = end / fps
    check(abs(seconds - dur) < 0.01, f'«{name}»: длительность {seconds:.4f} с')

    # Двигается ли модель: вершины меша в начале и в середине клипа.
    rig = rigs[0]
    rig.animation_data_create()
    rig.animation_data.action = act
    if hasattr(rig.animation_data, 'action_slot') and act.slots:
        rig.animation_data.action_slot = act.slots[0]
    for t in rig.animation_data.nla_tracks:
        t.mute = True

    def verts(frame):
        scene.frame_set(int(frame))
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        return [(mesh.matrix_world @ v.co) for v in ev.data.vertices]

    a, b = verts(start), verts((start + end) / 2)
    shift = max((p - q).length for p, q in zip(a, b))
    check(shift > 0.05, f'«{name}»: модель двигается (смещение до {shift:.3f} м)')

def base_image(mat):
    """Картинка, подключённая к Base Color материала."""
    if not (mat and mat.node_tree):
        return None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not (bsdf and bsdf.inputs['Base Color'].links):
        return None
    return getattr(bsdf.inputs['Base Color'].links[0].from_node, 'image', None)


def count(img, test):
    px = img.pixels[:]
    return sum(1 for i in range(0, len(px), 4) if test(px[i], px[i + 1], px[i + 2]))


blue = lambda r, g, b: b > 0.5 and r < 0.2
red = lambda r, g, b: r > 0.5 and b < 0.2
green = lambda r, g, b: g > 0.5 and r < 0.3 and b < 0.35   # 48,160,64

if materials is not None:
    names = [m.name for m in bpy.data.materials if m.users]
    for name in materials:
        check(name in names, f'материал «{name}» ({names})')
    face = bpy.data.materials.get('Face')
    img = base_image(face)
    check(img is not None, 'у «Face» карта подключена к Base Color')
    # Лицо, взятое по материалу, — свой меш; выделенное — слот того же меша.
    slots = [s.material.name for o in meshes for s in o.material_slots if s.material]
    skinned = [o for o in meshes if any(m.type == 'ARMATURE' for m in o.modifiers)
               and any(s.material and s.material.name == 'Face' for s in o.material_slots)]
    check(bool(skinned), f'«Face» стоит на меше с костями ({slots})')
elif variants is None:
    mats = [m for m in bpy.data.materials if m.users]
    names = [m.name for m in mats]
    check('Leaf' in names, f'материал «Leaf» ({names})')
    # Покраска: картинка подключена к Base Color, и в ней есть синий.
    img = base_image(bpy.data.materials.get('Leaf'))
    check(img is not None, 'карта покраски подключена к Base Color')
    if img:
        n = count(img, blue)
        check(n > 100, f'в карте есть синяя покраска ({n} текселей)')
else:
    got = [v.name for v in scene.gltf2_KHR_materials_variants_variants]
    check(got == variants, f'варианты в сцене: {got}')
    data = mesh.data
    by_variant = {}
    for prim in data.gltf2_variant_mesh_data:
        for v in prim.variants:
            by_variant[v.variant.variant_idx] = prim.material
    want = ['Leaf'] + [f'Leaf_{v}' for v in variants[1:]]
    got_mats = [by_variant.get(i).name if by_variant.get(i) else None for i in range(len(variants))]
    check(got_mats == want, f'материалы вариантов: {got_mats}')
    default = [m.name for m in data.materials if m]
    check(f'Leaf_{variants[1]}' in default[:1], f'по умолчанию — включённый при сохранении ({default[:1]})')
    for i, name in enumerate(variants):
        img = base_image(by_variant.get(i))
        if not img:
            check(False, f'«{name}»: карта подключена к Base Color')
            continue
        b, r, g = count(img, blue), count(img, red), count(img, green)
        if i == 0:
            check(b < 50 and r < 50 and g > 100, f'«{name}»: только общий низ (зелёных {g}, синих {b}, красных {r})')
        elif i == 1:
            check(b > 100 and r < 50 and g > 100, f'«{name}»: синий верх и общий низ (синих {b}, зелёных {g})')
        else:
            check(r > 100 and b < 50 and g > 100, f'«{name}»: красный верх и общий низ (красных {r}, зелёных {g})')

sys.exit(1 if fails else 0)
