// Demo connections must stay on loopback, even when changing the port.
export function localEmulatorHost(value='127.0.0.1:8095'){
  const match=/^127\.0\.0\.1:(\d{4,5})$/.exec(value);
  if(!match||Number(match[1])<1024||Number(match[1])>65535)throw Error('Local Firestore must use 127.0.0.1 and a valid port');
  return value;
}
