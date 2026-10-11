export async function ensureFolderPermission(folder){
  return !folder||await folder.queryPermission({mode:'readwrite'})==='granted'||await folder.requestPermission({mode:'readwrite'})==='granted';
}
