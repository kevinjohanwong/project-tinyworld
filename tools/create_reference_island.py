import bpy, math, os, random
random.seed(17)
OUT='/home/workspace/project-tinyworld/assets/reference-pond-island.glb'
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
def mat(n,c,r=.8,e=None):
 m=bpy.data.materials.new(n); m.diffuse_color=(*c,1); m.use_nodes=True; b=m.node_tree.nodes.get('Principled BSDF'); b.inputs['Base Color'].default_value=(*c,1); b.inputs['Roughness'].default_value=r
 if e:
  ec=b.inputs.get('Emission') or b.inputs.get('Emission Color'); es=b.inputs.get('Emission Strength')
  if ec: ec.default_value=(*e,1)
  if es: es.default_value=2.5
 return m
grass=mat('island grass',(.16,.28,.11)); soil=mat('soil',(.18,.11,.06)); water=mat('pond water',(.035,.16,.18),.18); stone=mat('stone',(.22,.24,.21)); wood=mat('dark wood',(.18,.08,.035)); roof=mat('tile roof',(.055,.07,.065)); wall=mat('house plaster',(.42,.31,.20)); window=mat('warm windows',(.72,.38,.10),.35,(1,.28,.04)); leaf=mat('foliage',(.12,.28,.08)); blossom=mat('blossom',(.72,.36,.38)); city=mat('distant buildings',(.055,.08,.085)); citywin=mat('city lights',(.85,.52,.18),.35,(1,.35,.05))
def cube(n,l,s,m,b=0):
 bpy.ops.mesh.primitive_cube_add(location=l); o=bpy.context.object; o.name=n; o.scale=s; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); o.data.materials.append(m)
 if b: q=o.modifiers.new('soft edges','BEVEL'); q.width=b; q.segments=1
 return o
def cyl(n,l,r,d,m,v=8):
 bpy.ops.mesh.primitive_cylinder_add(vertices=v,radius=r,depth=d,location=l); o=bpy.context.object; o.name=n; o.data.materials.append(m); return o
def ico(n,l,s,m):
 bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=l); o=bpy.context.object; o.name=n; o.scale=s; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); o.data.materials.append(m); return o
cube('island_rock',(0,-1.1,0),(12,1.1,8),soil); cube('island_grass_cap',(0,.05,0),(12.1,.18,8.1),grass); cube('pond',(-.2,.30,-2.2),(8.2,.05,2.3),water)
for i in range(15): ico('pond_rock',(-8+i*1.1,.35,-.1+.35*math.sin(i*1.4)),(.5,.22,.35),stone)
for i in range(18): ico('shore_rock',(random.uniform(-11,11),.35,random.choice([random.uniform(5.4,7.5),random.uniform(-7.5,-5)])),(random.uniform(.25,.65),random.uniform(.18,.35),random.uniform(.25,.55)),stone)
cube('house_body',(-5.2,2,1.4),(3.1,1.9,1.8),wall,.12); cube('house_lower',(-5.2,.75,1.4),(3.35,.45,1.95),wood); cube('house_window_front',(-5.2,2.15,-.45),(2.35,.06,.7),window); cube('house_window_side',(-8.32,2.05,1.6),(.06,.7,.75),window); cube('house_sign',(-5.2,1.1,-.5),(1.25,.08,.32),wood)
for y,s in [(4,1),(4.55,.72)]:
 bpy.ops.mesh.primitive_cone_add(vertices=4,radius1=3.8*s,radius2=2.7*s,depth=1.2*s,location=(-5.2,y,1.4),rotation=(0,0,math.radians(45))); bpy.context.object.name='house_tile_roof'; bpy.context.object.data.materials.append(roof)
cube('bridge_deck',(5.3,1,-2.15),(3,.18,.7),wood)
for side in [-1,1]:
 cube('bridge_rail',(5.3,1.85,-2.15+side*.62),(3,.12,.08),wood)
 for x in [-7,-5.5,-4,-2.5,-1,.5,2]: cube('bridge_post',(x,1.4,-2.15+side*.62),(.08,.7,.08),wood)
for x in [-9,-2,3,8]:
 cyl('utility_pole',(x,3,3.8),.13,6,wood)
 for y in [4.9,5.35]: cube('crossarm',(x,y,3.8),(1,.07,.08),wood)
 for z in [-.22,.22]:
  bpy.ops.mesh.primitive_cylinder_add(vertices=8,radius=.025,depth=18,location=(0,5.2,3.8+z),rotation=(0,math.radians(90),0)); bpy.context.object.name='utility_wire'; bpy.context.object.data.materials.append(wood)
def tree(x,z,h=4.5,m=None):
 cyl('tree_trunk',(x,1.7+h*.35,z),.22,h,wood,7)
 for j in range(5):
  a=j*1.25+random.random(); r=1+random.random()*.7; ico('tree_canopy',(x+math.cos(a)*r,2.7+h*.52+random.uniform(-.4,.5),z+math.sin(a)*r),(1.5,1.15,1.3),m or leaf)
for p in [(-10,1.8,5.5),(-9,-4.2,4.4),(-2,5,5),(2,5.7,5.7),(8,4.7,5),(10,-4.5,5.8),(-10,-5.5,4.8)]: tree(*p)
for p in [(-8,4.3,4.2),(9,1.8,4.5),(10,5.8,4.7)]: tree(*p,m=blossom)
for x,z,h,w in [(-8,10,9,2.5),(-4,11,13,2),(1,10,8,2.8),(5,11,16,2.3),(9,10,11,2.6)]:
 cube('background_building',(x,h/2-.1,z),(w,h/2,1.1),city)
 for yy in range(2,int(h),2):
  for xx in [-.55,0,.55]:
   if random.random()>.25: cube('building_window',(x+xx*w/1.5,yy,z-1.12),(.08,.12,.03),citywin)
for i in range(20):
 a=random.random()*math.tau; r=random.uniform(1,7.5); x=-.2+math.cos(a)*r; z=-2.2+math.sin(a)*r*.28
 bpy.ops.mesh.primitive_cylinder_add(vertices=7,radius=random.uniform(.18,.45),depth=.025,location=(x,.38,z)); bpy.context.object.name='lily_pad'; bpy.context.object.data.materials.append(leaf)
 if i%4==0: ico('lotus',(x,.55,z),(.18,.18,.12),blossom)
bpy.ops.object.empty_add(type='PLAIN_AXES',location=(0,0,0)); bpy.context.object.name='TinyWorld_Reference_Island_Origin'
bpy.context.scene['reference']='2D viewpoint reconstruction: pond house bridge city garden'
bpy.ops.object.select_all(action='SELECT'); os.makedirs(os.path.dirname(OUT),exist_ok=True); bpy.ops.export_scene.gltf(filepath=OUT,export_format='GLB',export_apply=True); print(OUT)
