# Два персонажа для проверки лица с выражениями:
#   kid.glb — тело и голова одним мешем, один материал «Skin»: лицо задаётся
#             выделением граней; клипы Idle (1 с) и Nod (2 с);
#   fox.glb — у головы спереди свой материал «Face», остальное «Fur»: лицо
#             берётся по материалу; клипы Run (1 с) и Wag (1.5 с).
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#     -P tests/fixtures/make-characters.py -- tests/fixtures
#
# Веса — по высоте, без автоматики: модель собирается одинаково в любой версии.

import sys
import os
import math
import bpy
import bmesh

out_dir = sys.argv[sys.argv.index('--') + 1]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 24


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*rgb, 1)
    return m


def character(body_rgb, head_mats, face_test=None):
    """Тело (цилиндр) и голова (шар) одним мешем, низ — z = 0."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.18, depth=0.9, location=(0, 0, 0.45))
    body = bpy.context.active_object
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=0.25, location=(0, 0, 1.15))
    head = bpy.context.active_object
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    ob = bpy.context.active_object
    for m in head_mats:
        ob.data.materials.append(m)
    # Лицо спереди: в Blender перед — к −Y (в glTF это +Z, вид «спереди»).
    if face_test is not None:
        for p in ob.data.polygons:
            c = ob.matrix_world @ p.center
            if face_test(c):
                p.material_index = 1
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def rig(ob):
    bpy.ops.object.armature_add(location=(0, 0, 0))
    r = bpy.context.active_object
    r.name = 'Rig'
    bpy.ops.object.mode_set(mode='EDIT')
    eb = r.data.edit_bones
    root = eb[0]
    root.name = 'Spine'
    root.head, root.tail = (0, 0, 0), (0, 0, 0.9)
    neck = eb.new('Head')
    neck.head, neck.tail = (0, 0, 0.9), (0, 0, 1.4)
    neck.parent = root
    neck.use_connect = True
    bpy.ops.object.mode_set(mode='OBJECT')
    g1 = ob.vertex_groups.new(name='Spine')
    g2 = ob.vertex_groups.new(name='Head')
    for v in ob.data.vertices:
        z = (ob.matrix_world @ v.co).z
        w = min(1.0, max(0.0, (z - 0.8) / 0.2))
        g1.add([v.index], 1.0 - w, 'REPLACE')
        g2.add([v.index], w, 'REPLACE')
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = r
    ob.parent = r
    return r


def clips(r, spec):
    r.animation_data_create()
    ad = r.animation_data
    pb = r.pose.bones['Head']
    pb.rotation_mode = 'XYZ'
    for name, frames, angle in spec:
        act = bpy.data.actions.new(name)
        ad.action = act
        for f, a in [(1, 0), (1 + frames // 2, angle), (1 + frames, 0)]:
            pb.rotation_euler = (math.radians(a), 0, 0)
            pb.keyframe_insert('rotation_euler', frame=f)
        tr = ad.nla_tracks.new()
        tr.name = name
        tr.strips.new(name, 1, act)
        act.use_fake_user = True
        ad.action = None
    pb.rotation_euler = (0, 0, 0)


def export(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=True,
                              export_animation_mode='ACTIONS', export_skins=True)
    print('[characters] записано', path)


reset()
kid = character((0.9, 0.7, 0.6), [material('Skin', (0.9, 0.7, 0.6))])
kid.name = 'Kid'
clips(rig(kid), [('Idle', 24, 10), ('Nod', 48, -30)])
export(os.path.join(out_dir, 'kid.glb'))

reset()
fur = material('Fur', (0.8, 0.4, 0.1))
face = material('Face', (0.95, 0.9, 0.8))
fox = character((0.8, 0.4, 0.1), [fur, face],
                face_test=lambda c: c.z > 1.0 and c.y < -0.12)
fox.name = 'Fox'
clips(rig(fox), [('Run', 24, 15), ('Wag', 36, -20)])
export(os.path.join(out_dir, 'fox.glb'))
