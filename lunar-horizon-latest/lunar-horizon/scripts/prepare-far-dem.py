import rasterio,numpy as np,json
with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.TIF',GDAL_HTTP_TIMEOUT='60'):
 with rasterio.open('https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF') as ds:
  a=ds.read(1,out_shape=(950,950),resampling=rasterio.enums.Resampling.bilinear)
  np.asarray(a,dtype='<f4').tofile('data/far.bin')
  json.dump({'width':950,'height':950,'x0':-304000,'y0':304000,'dx':640,'dy':-640,'radius':1737400},open('data/far.json','w'))
  print('far saved',a.shape,flush=True)
