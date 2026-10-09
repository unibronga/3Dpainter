# Тестовая модель для проверки анимаций в GLB: стебель на двух костях,
# материал «Leaf», два клипа — Sway (1 с) и Bend (2 с).
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P tests/fixtures/make-leaf-rig.py -- tests/fixtures/leaf-rig.glb
#
# Веса заданы по высоте, а не автоматически: так модель собирается одинаково
# в любой версии Blender.

import sys
import math
import bpy
import bmesh

out = sys.argv[sys.argv.index('--') + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24

# Стебель: восьмигранная труба высотой 1 м, шесть поясов.
bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.08, depth=1.0, location=(0, 0, 0.5))
stem = bpy.context.active_object
stem.name = 'Stem'
bm = bmesh.new()
bm.from_mesh(stem.data)
vertical = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) > 0.5]
bmesh.ops.subdivide_edges(bm, edges=vertical, cuts=5, use_grid_fill=False)
bm.to_mesh(stem.data)
bm.free()
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(island_margin=0.02)
bpy.ops.object.mode_set(mode='OBJECT')

mat = bpy.data.materials.new('Leaf')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.2, 0.55, 0.15, 1)
stem.data.materials.append(mat)

# Арматура: две кости друг над другом.
bpy.ops.object.armature_add(location=(0, 0, 0))
rig = bpy.context.active_object
rig.name = 'Rig'
bpy.ops.object.mode_set(mode='EDIT')
eb = rig.data.edit_bones
root = eb[0]
root.name = 'Root'
root.head, root.tail = (0, 0, 0), (0, 0, 0.5)
tip = eb.new('Tip')
tip.head, tip.tail = (0, 0, 0.5), (0, 0, 1.0)
tip.parent = root
tip.use_connect = True
bpy.ops.object.mode_set(mode='OBJECT')

# Веса по высоте: низ — Root, верх — Tip, посередине плавный переход.
g_root = stem.vertex_groups.new(name='Root')
g_tip = stem.vertex_groups.new(name='Tip')
for v in stem.data.vertices:
    z = (stem.matrix_world @ v.co).z
    w = min(1.0, max(0.0, (z - 0.3) / 0.4))
    g_root.add([v.index], 1.0 - w, 'REPLACE')
    g_tip.add([v.index], w, 'REPLACE')
mod = stem.modifiers.new('Armature', 'ARMATURE')
mod.object = rig
stem.parent = rig

# Два клипа на верхней кости.
rig.animation_data_create()
ad = rig.animation_data
pb = rig.pose.bones['Tip']
pb.rotation_mode = 'XYZ'


def clip(name, keys):
    act = bpy.data.actions.new(name)
    ad.action = act
    for frame, angle in keys:
        pb.rotation_euler = (angle, 0, 0)
        pb.keyframe_insert('rotation_euler', frame=frame)
    track = ad.nla_tracks.new()
    track.name = name
    track.strips.new(name, 1, act)
    act.use_fake_user = True
    ad.action = None
    return act


clip('Sway', [(1, 0), (13, math.radians(30)), (25, 0)])                       # 24 кадра = 1 с
clip('Bend', [(1, 0), (25, math.radians(-60)), (49, 0)])                      # 48 кадров = 2 с
pb.rotation_euler = (0, 0, 0)

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_skins=True,
)
print('[leaf-rig] записано', out)
