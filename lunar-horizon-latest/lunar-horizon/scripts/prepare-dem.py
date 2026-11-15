# Download only the COG tiles needed for the bundled 40 km polar square.
# Requires numpy, rasterio and tifffile.
import urllib.request, concurrent.futures, os, tempfile, tifffile, numpy as np, rasterio, json
url='https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF'
def fetch(start,size):
 for attempt in range(3):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'Range':f'bytes={start}-{start+size-1}'}),timeout=40) as r:
    data=r.read()
    if r.status!=206 or len(data)!=size or not r.headers.get('Content-Range','').startswith(f'bytes {start}-'): raise ValueError('Invalid range')
    return data
  except Exception:
   if attempt==2: raise
path=os.path.join(tempfile.gettempdir(),'lola20-sparse.tif')
with open(path,'wb') as f: f.truncate(2696082051); f.seek(0);f.write(fetch(0,1048576))
with tifffile.TiffFile(path) as t:
 p=t.pages[0]; offsets=p.dataoffsets;counts=p.databytecounts;tw=p.tilewidth;th=p.tilelength;width=p.imagewidth
 print('metadata',width,tw,flush=True)
 indices=[y*((width+tw-1)//tw)+x for y in range(14200//th,(16200-1)//th+1) for x in range(14200//tw,(16200-1)//tw+1)]
 def job(i): return offsets[i],fetch(offsets[i],counts[i])
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool,open(path,'r+b') as f:
  for n,(offset,data) in enumerate(pool.map(job,indices)):
   f.seek(offset);f.write(data)
   print(n+1,'/',len(indices),flush=True)
with rasterio.open(path) as ds:
 w=rasterio.windows.Window(14200,14200,2000,2000); a=ds.read(1,window=w);tr=ds.window_transform(w)
 assert np.isfinite(a).all()
 meta={'width':2000,'height':2000,'x0':tr.c,'y0':tr.f,'dx':tr.a,'dy':tr.e,'radius':1737400,'source':url,'frame':'MOON_ME DE421','resolution':20,'bounds':[-20000,-20000,20000,20000]}
 np.asarray(a,dtype='<f4').tofile('data/terrain.bin');json.dump(meta,open('data/terrain.json','w'))
 print('saved',a.shape,a.min(),a.max(),flush=True)

os.remove(path)
