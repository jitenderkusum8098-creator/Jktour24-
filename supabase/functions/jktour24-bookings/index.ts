import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
const url=Deno.env.get("SUPABASE_URL")!, serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, anonKey=Deno.env.get("SUPABASE_ANON_KEY")!;
const db=createClient(url,serviceKey);
 const bounded=(v:any,n=300)=>String(v??"").trim().slice(0,n);
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"POST required"},405);
 let body:Record<string,any>;try{body=await req.json()}catch{return json({error:"Invalid JSON"},400)}

 const razorpayKeyId=Deno.env.get("RAZORPAY_KEY_ID")||"", razorpayKeySecret=Deno.env.get("RAZORPAY_KEY_SECRET")||"";
 const razorpayAuth="Basic "+btoa(razorpayKeyId+":"+razorpayKeySecret);
 if(body.action==="create_payment_order"){
  if(!razorpayKeyId||!razorpayKeySecret)return json({error:"Razorpay keys are not configured on the secure server yet."},503);
  const token=bounded(body.status_token,100),plan=bounded(body.payment_plan,20),custom=Number(body.custom_amount);
  if(!/^[a-f0-9]{48,80}$/i.test(token))return json({error:"Invalid booking status link."},400);
  const {data:b,error:be}=await db.from("bookings").select("id,booking_code,status_token,fare_total,payment_status,amount_received,payment_method,status,customer_name,customer_mobile,customer_email").eq("status_token",token).maybeSingle();
  if(be||!b)return json({error:"Booking not found."},404);
  if(b.payment_method!=="online"||["expired","cancelled"].includes(b.status))return json({error:"This booking is not eligible for online payment."},400);
  const fare=Math.round(Number(b.fare_total)||0),received=Math.round(Number(b.amount_received)||0),remaining=fare-received;
  let amount=0;
  if(plan==="advance_40")amount=Math.round(fare*0.4);
  else if(plan==="full")amount=remaining;
  else if(plan==="custom"){if(!Number.isFinite(custom)||custom<100)return json({error:"Custom Payment कम से कम ₹100 होना चाहिए।"},400);amount=Math.round(custom);}
  else return json({error:"Choose 40% advance, custom amount, or full payment."},400);
  if(amount<1||amount>remaining)return json({error:"Payment amount must be greater than zero and no more than the remaining balance ₹"+remaining+"."},400);
  const response=await fetch("https://api.razorpay.com/v1/orders",{method:"POST",headers:{"Authorization":razorpayAuth,"Content-Type":"application/json"},body:JSON.stringify({amount:amount*100,currency:"INR",receipt:String(b.booking_code).slice(0,40),notes:{booking_code:b.booking_code,booking_id:b.id,payment_plan:plan}})});
  const order=await response.json();
  if(!response.ok||!order.id)return json({error:order.error?.description||"Could not create Razorpay order."},502);
  const {error:saveError}=await db.from("jktour24_payment_orders").insert({booking_id:b.id,razorpay_order_id:order.id,amount_paise:amount*100,currency:"INR",status:"created"});
  if(saveError)return json({error:"Payment order could not be saved securely."},500);
  return json({key_id:razorpayKeyId,order_id:order.id,amount:amount*100,currency:"INR",booking_code:b.booking_code,customer_name:b.customer_name,customer_mobile:b.customer_mobile,customer_email:b.customer_email||""},201);
 }
 if(body.action==="verify_payment"){
  if(!razorpayKeyId||!razorpayKeySecret)return json({error:"Razorpay keys are not configured."},503);
  const orderId=bounded(body.razorpay_order_id,100),paymentId=bounded(body.razorpay_payment_id,100),signature=bounded(body.razorpay_signature,256);
  if(!orderId||!paymentId||!signature)return json({error:"Missing payment verification details."},400);
  const {data:po,error:poError}=await db.from("jktour24_payment_orders").select("id,booking_id,razorpay_order_id,amount_paise,status").eq("razorpay_order_id",orderId).maybeSingle();
  if(poError||!po)return json({error:"Payment order not found."},404);
  const enc=new TextEncoder(),key=await crypto.subtle.importKey("raw",enc.encode(razorpayKeySecret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(orderId+"|"+paymentId)));
  const expected=[...digest].map(x=>x.toString(16).padStart(2,"0")).join("");
  if(expected.length!==signature.length||![...expected].every((c,i)=>c===signature[i]))return json({error:"Payment signature verification failed."},400);
  if(po.status==="paid")return json({ok:true,message:"Payment already verified."});
  const paymentResponse=await fetch("https://api.razorpay.com/v1/payments/"+encodeURIComponent(paymentId),{headers:{"Authorization":razorpayAuth}});
  const payment=await paymentResponse.json();
  if(!paymentResponse.ok||payment.order_id!==orderId||Number(payment.amount)!==Number(po.amount_paise)||payment.currency!=="INR"||!["captured","authorized"].includes(payment.status))return json({error:"Razorpay payment is not verified/captured yet."},400);
  if(payment.status!=="captured")return json({error:"Payment authorized but not captured yet. Please wait and check status."},409);
  const {data:b,error:bookingError}=await db.from("bookings").select("id,fare_total,amount_received").eq("id",po.booking_id).single();
  if(bookingError||!b)return json({error:"Booking not found for this payment."},404);
  const newReceived=Math.min(Number(b.fare_total)||0,(Number(b.amount_received)||0)+(Number(po.amount_paise)/100));
  const paymentStatus=newReceived>=(Number(b.fare_total)||0)?"fully_paid":"advance_received";
  const {error:updateOrderError}=await db.from("jktour24_payment_orders").update({status:"paid",razorpay_payment_id:paymentId,updated_at:new Date().toISOString()}).eq("id",po.id).eq("status","created");
  if(updateOrderError)return json({error:"Could not save payment confirmation."},500);
  const {error:updateBookingError}=await db.from("bookings").update({amount_received:newReceived,payment_status:paymentStatus,updated_at:new Date().toISOString()}).eq("id",b.id);
  if(updateBookingError)return json({error:"Payment verified but booking update failed. Contact JKTour24 support."},500);
  return json({ok:true,booking_code:body.booking_code||"",amount_received:newReceived,payment_status:paymentStatus,message:"Payment verified successfully."});
 }

 if(body.action==="get_settings"){
  const {data,error}=await db.from("jktour24_settings").select("setting_value").eq("setting_key","site_config").maybeSingle();
  if(error)return json({error:"Could not load site settings"},500);
  return json({settings:data?.setting_value||{}});
 }
 if(body.action==="status"){
  const token=String(body.token||"");if(!/^[a-f0-9]{48,80}$/i.test(token))return json({error:"Invalid status link"},400);
  const {data,error}=await db.from("bookings").select("id,booking_code,package_slug,package_name,customer_name,customer_mobile,travel_date,pickup_point,pickup_time,drop_point,drop_time,selected_seats,fare_total,payment_plan,payment_method,payment_status,amount_received,ticket_status,ticket_number,ticket_data,status,created_at,updated_at").eq("status_token",token).maybeSingle();
  if(error)return json({error:"Could not load booking status"},500);if(!data)return json({error:"Booking not found"},404);
  const deadline=new Date(data.created_at).getTime()+10*60*1000;
  if(data.payment_status==="pending"&&data.ticket_status!=="issued"&&Date.now()>=deadline){
   await db.from("bookings").update({status:"expired"}).eq("id",data.id).eq("payment_status","pending");
   await db.from("jktour24_seat_holds").delete().eq("booking_id",data.id).eq("hold_status","held");
   data.status="expired";
  }
  const {data:paidOrders}=await db.from("jktour24_payment_orders").select("amount_paise").eq("booking_id",data.id).eq("status","paid");
  data.online_paid_amount=Math.round((paidOrders||[]).reduce((sum:any,p:any)=>sum+(Number(p.amount_paise)||0),0)/100);
  data.balance_due=Math.max(0,Number(data.fare_total||0)-Number(data.amount_received||0));
  data.hold_expires_at=new Date(deadline).toISOString();
  return json({booking:data});
 }
 if(body.action==="seat_availability"){
  const slug=bounded(body.package_slug,100),date=bounded(body.travel_date,10);
  if(!slug||!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:"Package aur travel date required hain"},400);
  const now=new Date().toISOString();
  await db.from("jktour24_seat_holds").delete().eq("hold_status","held").lte("expires_at",now);
  const {data:holds,error:he}=await db.from("jktour24_seat_holds").select("seat_number,hold_status").eq("package_slug",slug).eq("travel_date",date).in("hold_status",["held","confirmed"]).gt("expires_at",now);
  if(he)return json({error:"Seat availability load nahi hui"},500);
  const {data:issued,error:ie}=await db.from("bookings").select("selected_seats").eq("package_slug",slug).eq("travel_date",date).eq("ticket_status","issued").not("status","in","(expired,cancelled)");
  if(ie)return json({error:"Confirmed seats check nahi ho paayin"},500);
  const seats=new Set((holds||[]).map((x:any)=>String(x.seat_number))),heldSeats=new Set((holds||[]).filter((x:any)=>x.hold_status==="held").map((x:any)=>String(x.seat_number))),confirmedSeats=new Set((holds||[]).filter((x:any)=>x.hold_status==="confirmed").map((x:any)=>String(x.seat_number)));
  for(const b of issued||[])for(const s of Array.isArray(b.selected_seats)?b.selected_seats:[]){seats.add(String(s));confirmedSeats.add(String(s));}
  return json({blocked_seats:[...seats],held_seats:[...heldSeats],confirmed_seats:[...confirmedSeats]});
 }
 if(body.action==="create"){
  const p=body.booking||{},required=["package_slug","package_name","customer_name","customer_mobile","payment_plan","payment_method"];
  if(required.some(k=>!String(p[k]??"").trim()))return json({error:"Required booking information is missing"},400);
  if(!["advance_40","full","custom"].includes(p.payment_plan)||!["cash","online"].includes(p.payment_method))return json({error:"Invalid payment choice"},400);
  const token=crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","").slice(0,16),code="JK"+crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase();
  const row={booking_code:code,status_token:token,package_slug:String(p.package_slug),package_name:String(p.package_name),customer_name:String(p.customer_name).slice(0,120),customer_mobile:String(p.customer_mobile).replace(/[^0-9+]/g,"").slice(0,20),customer_email:p.customer_email?String(p.customer_email).slice(0,160):null,customer_age:Number.isFinite(Number(p.customer_age))?Number(p.customer_age):null,customer_gender:p.customer_gender?String(p.customer_gender).slice(0,30):null,emergency_contacts:Array.isArray(p.emergency_contacts)?p.emergency_contacts:[],passenger_details:Array.isArray(p.passenger_details)?p.passenger_details:[],pickup_point:p.pickup_point?String(p.pickup_point).slice(0,200):null,pickup_time:p.pickup_time?String(p.pickup_time).slice(0,50):null,drop_point:p.drop_point?String(p.drop_point).slice(0,200):null,drop_time:p.drop_time?String(p.drop_time).slice(0,50):null,travel_date:p.travel_date||null,bus_details:p.bus_details&&typeof p.bus_details==="object"?p.bus_details:{},selected_seats:Array.isArray(p.selected_seats)?p.selected_seats:[],fare_total:Math.max(0,Number(p.fare_total)||0),payment_plan:p.payment_plan,payment_method:p.payment_method,payment_status:"pending",ticket_status:"not_issued",customer_notes:p.customer_notes?String(p.customer_notes).slice(0,1000):null};
  if(!row.travel_date||!row.selected_seats.length)return json({error:"यात्रा की तारीख और सीटें चुनना जरूरी है"},400);
  const now=new Date().toISOString();
  await db.from("jktour24_seat_holds").delete().eq("hold_status","held").lte("expires_at",now);
  const {data:existingHolds,error:holdReadError}=await db.from("jktour24_seat_holds").select("seat_number").eq("package_slug",row.package_slug).eq("travel_date",row.travel_date).in("hold_status",["held","confirmed"]).in("seat_number",row.selected_seats.map(String)).gt("expires_at",now);
  if(holdReadError)return json({error:"Seat availability could not be checked. Please try again."},500);
  const {data:issued,error:issuedError}=await db.from("bookings").select("selected_seats").eq("package_slug",row.package_slug).eq("travel_date",row.travel_date).eq("ticket_status","issued").neq("status","expired");
  if(issuedError)return json({error:"Confirmed seats could not be checked. Please try again."},500);
  const chosen=row.selected_seats.map((x:any)=>String(x));
  const alreadyBooked=new Set((issued||[]).flatMap((x:any)=>Array.isArray(x.selected_seats)?x.selected_seats.map((v:any)=>String(v)):[]));
  const conflict=(existingHolds||[]).some((x:any)=>chosen.includes(String(x.seat_number)))||chosen.some((x:string)=>alreadyBooked.has(x));
  if(conflict)return json({error:"आपकी चुनी हुई सीट में से कोई सीट पहले ही बुक या होल्ड है। कृपया दूसरी सीट चुनें।"},409);
  const {data,error}=await db.from("bookings").insert(row).select("id,booking_code,status_token,created_at").single();
  if(error)return json({error:"Booking could not be saved"},500);
  const expiresAt=new Date(Date.now()+10*60*1000).toISOString();
  const holds=row.selected_seats.map((seat:any)=>({package_slug:row.package_slug,travel_date:row.travel_date,seat_number:String(seat),booking_id:data.id,booking_code:code,hold_status:"held",expires_at:expiresAt}));
  const {error:reserveError}=await db.from("jktour24_seat_holds").insert(holds);
  if(reserveError){await db.from("bookings").delete().eq("id",data.id);return json({error:"यह सीट अभी किसी अन्य ग्राहक ने ले ली है। कृपया दूसरी सीट चुनें।"},409);}
  return json({booking:{...data,hold_expires_at:expiresAt}},201);
 }
 if(body.action==="admin_save_settings"){
  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer "))return json({error:"Admin login required"},401);
  const auth=createClient(url,anonKey,{global:{headers:{Authorization:authHeader}}});
  const {data:userData,error:userError}=await auth.auth.getUser();
  if(userError||!userData.user||userData.user.app_metadata?.role!=="admin")return json({error:"Admin permission required. Use an authorized admin account."},403);
  if(!body.settings||typeof body.settings!=="object"||Array.isArray(body.settings))return json({error:"Invalid settings"},400);
  const settings=body.settings;
  if(!settings.packages||!settings.buses||!settings.stops||!settings.payment)return json({error:"Package, bus, stop and payment settings are required"},400);
  const {error}=await db.from("jktour24_settings").upsert({setting_key:"site_config",setting_value:settings,updated_at:new Date().toISOString(),updated_by:userData.user.id},{onConflict:"setting_key"});
  if(error)return json({error:"Could not save settings"},500);
  return json({ok:true,settings});
 }
 if(["admin_list","admin_update"].includes(body.action)){
  const authHeader=req.headers.get("Authorization")||"";
  if(!authHeader.startsWith("Bearer "))return json({error:"Admin login required"},401);
  const auth=createClient(url,anonKey,{global:{headers:{Authorization:authHeader}}});
  const {data:userData,error:userError}=await auth.auth.getUser();
  if(userError||!userData.user||userData.user.app_metadata?.role!=="admin")return json({error:"Admin permission required. Use an authorized admin account."},403);
  if(body.action==="admin_list"){
   const {data,error}=await db.from("bookings").select("id,booking_code,status,package_name,customer_name,customer_mobile,emergency_contacts,passenger_details,pickup_point,pickup_time,drop_point,drop_time,selected_seats,fare_total,payment_plan,payment_method,payment_status,amount_received,ticket_status,ticket_number,travel_date,created_at").order("created_at",{ascending:false}).limit(200);
   if(error)return json({error:"Could not load bookings"},500);const bookings=data||[];if(bookings.length){const ids=bookings.map((b:any)=>b.id);const {data:paidOrders}=await db.from("jktour24_payment_orders").select("booking_id,amount_paise").in("booking_id",ids).eq("status","paid");const onlineByBooking=new Map<string,number>();for(const p of paidOrders||[])onlineByBooking.set(String(p.booking_id),(onlineByBooking.get(String(p.booking_id))||0)+(Number(p.amount_paise)||0));for(const b of bookings){b.online_paid_amount=Math.round((onlineByBooking.get(String(b.id))||0)/100);b.balance_due=Math.max(0,Number(b.fare_total||0)-Number(b.amount_received||0));}}return json({bookings});
  }
  const id=String(body.id||""),payment=String(body.payment_status||"");
  if(!id||!["pending","advance_received","fully_paid","payment_issue"].includes(payment))return json({error:"Invalid update"},400);
  const patch:any={payment_status:payment,amount_received:Math.max(0,Number(body.amount_received)||0),admin_notes:String(body.admin_notes||"").slice(0,1000)};
  if(body.issue_ticket===true){
   if(!["advance_received","fully_paid"].includes(payment))return json({error:"Confirm received payment before issuing a ticket"},400);
   patch.ticket_status="issued";patch.ticket_number="TKT-"+String(body.booking_code||"").replace(/[^A-Z0-9]/gi,"").slice(0,20);patch.ticket_data=body.ticket_data&&typeof body.ticket_data==="object"?body.ticket_data:{issued_at:new Date().toISOString(),message:"JKTour24 ticket issued by admin"};
  }
  const {data,error}=await db.from("bookings").update(patch).eq("id",id).select("booking_code,payment_status,amount_received,ticket_status,ticket_number,ticket_data").single();
  if(error)return json({error:"Booking update failed"},500);
  if(body.issue_ticket===true){await db.from("jktour24_seat_holds").update({hold_status:"confirmed",expires_at:"9999-12-31T23:59:59.000Z"}).eq("booking_id",id).eq("hold_status","held");}
  if(payment==="pending"){await db.from("jktour24_seat_holds").delete().eq("booking_id",id).eq("hold_status","held");}
  return json({booking:data});
 }

 async function authorizedUser(req:Request, role:string){
  const h=req.headers.get("Authorization")||"";
  if(!h.startsWith("Bearer "))return {error:"Login required",user:null};
  const auth=createClient(url,anonKey,{global:{headers:{Authorization:h}}});
  const {data,error}=await auth.auth.getUser();
  if(error||!data.user)return {error:"Login session invalid",user:null};
  if(data.user.app_metadata?.role!==role)return {error:"Permission denied",user:null};
  return {error:null,user:data.user};
 }
 if(body.action==="manager_login"){
  const name=bounded(body.full_name,120).toLowerCase(),mobile=bounded(body.mobile,25),password=String(body.password||"");
  if(!name||!mobile||!password)return json({error:"Naam, mobile aur password bharein"},400);
  const {data:manager,error:managerError}=await db.from("tour_managers").select("user_id,full_name,email,mobile,active").eq("mobile",mobile).maybeSingle();
  if(managerError||!manager||!manager.active||String(manager.full_name||"").trim().toLowerCase()!==name)return json({error:"Manager name ya mobile number sahi nahi hai"},401);
  const authClient=createClient(url,anonKey);
  const {data:loginData,error:loginError}=await authClient.auth.signInWithPassword({email:manager.email,password});
  if(loginError||!loginData.session||loginData.user?.app_metadata?.role!=="tour_manager")return json({error:"Password galat hai"},401);
  return json({session:{access_token:loginData.session.access_token,refresh_token:loginData.session.refresh_token}});
 }
 if(body.action==="admin_create_tour_manager"){
  const {error:authError,user}=await authorizedUser(req,"admin");
  if(authError||!user)return json({error:authError||"Admin permission required"},403);
  const name=bounded(body.full_name,120),mobile=bounded(body.mobile,25),digits=mobile.replace(/\\D/g,"");
  if(!name||digits.length<7)return json({error:"Manager ka naam aur sahi mobile number zaroori hai"},400);
  const {data:existing}=await db.from("tour_managers").select("user_id").eq("mobile",mobile).maybeSingle();
  if(existing)return json({error:"Is mobile number se Tour Manager pehle se bana hua hai"},409);
  const email="tm."+digits+"@manager.jktour24.com",password=name;
  const {data:created,error:createError}=await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:name},app_metadata:{role:"tour_manager"}});
  if(createError||!created.user)return json({error:createError?.message||"Could not create manager login"},400);
  const {error:profileError}=await db.from("tour_managers").insert({user_id:created.user.id,full_name:name,email,mobile,active:true});
  if(profileError){await db.auth.admin.deleteUser(created.user.id);return json({error:"Manager profile could not be saved"},500);}
  return json({manager:{user_id:created.user.id,full_name:name,mobile,active:true}},201);
 }
 if(body.action==="admin_list_tour_managers"){
  const {error:authError,user}=await authorizedUser(req,"admin");if(authError||!user)return json({error:authError||"Admin permission required"},403);
  const {data,error}=await db.from("tour_managers").select("user_id,full_name,email,mobile,active,created_at").order("created_at",{ascending:false});
  if(error)return json({error:"Could not load Tour Managers"},500);return json({managers:data||[]});
 }
 if(body.action==="admin_seat_report"){
  const {error:authError,user}=await authorizedUser(req,"admin");if(authError||!user)return json({error:authError||"Admin permission required"},403);
  const {data,error}=await db.from("bookings").select("id,package_slug,package_name,travel_date,selected_seats,bus_details,ticket_status,payment_status,status,created_at").order("travel_date",{ascending:true}).limit(5000);
  if(error)return json({error:"Could not load package seat report"},500);
  const rows=new Map();
  for(const b of data||[]){
   const key=String(b.package_slug||"unknown")+"|"+String(b.travel_date||"date_tbd");
   if(!rows.has(key))rows.set(key,{package_slug:b.package_slug||"",package_name:b.package_name||b.package_slug||"Package",travel_date:b.travel_date||null,capacity:Number(b.bus_details?.capacity)||null,booking_count:0,confirmed_bookings:0,pending_bookings:0,confirmed_seats:[],pending_seats:[]});
   const r=rows.get(key),seats=Array.isArray(b.selected_seats)?b.selected_seats.map((s:any)=>String(s)):[],valid=b.status!=="expired"&&b.status!=="cancelled"&&b.ticket_status!=="cancelled";
   if(Number(b.bus_details?.capacity)>0)r.capacity=Number(b.bus_details.capacity);
   if(valid){r.booking_count++;if(b.ticket_status==="issued"){r.confirmed_bookings++;seats.forEach((s:string)=>r.confirmed_seats.push(s));}else if(b.status!=="expired"){r.pending_bookings++;seats.forEach((s:string)=>r.pending_seats.push(s));}}
  }
  const report=[...rows.values()].map((r:any)=>{r.confirmed_seats=[...new Set(r.confirmed_seats)];r.pending_seats=[...new Set(r.pending_seats)].filter((s:string)=>!r.confirmed_seats.includes(s));r.confirmed_seat_count=r.confirmed_seats.length;r.pending_seat_count=r.pending_seats.length;r.available_seats=r.capacity===null?null:Math.max(0,r.capacity-r.confirmed_seat_count-r.pending_seat_count);return r;});
  return json({report});
 }
 if(body.action==="admin_list_journeys"){
  const {error:authError,user}=await authorizedUser(req,"admin");if(authError||!user)return json({error:authError||"Admin permission required"},403);
  const {data,error}=await db.from("tour_journeys").select("*,tour_managers(full_name,email,mobile),tour_journey_stops(*)").order("travel_date",{ascending:true});
  if(error)return json({error:"Could not load tours"},500);return json({journeys:data||[]});
 }
 if(body.action==="admin_save_journey"){
  const {error:authError,user}=await authorizedUser(req,"admin");if(authError||!user)return json({error:authError||"Admin permission required"},403);
  const p=body.journey||{},title=bounded(p.title,180),id=bounded(p.id,60);if(!title)return json({error:"Tour name is required"},400);
  const patch:any={title,package_slug:bounded(p.package_slug,100)||null,travel_date:p.travel_date||null,bus_label:bounded(p.bus_label,100)||null,pickup_points:Array.isArray(p.pickup_points)?p.pickup_points.slice(0,80):[],manager_user_id:bounded(p.manager_user_id,60)||null,welcome_message:bounded(p.welcome_message,1200)||null,packing_list:Array.isArray(p.packing_list)?p.packing_list.slice(0,50):[],updated_at:new Date().toISOString()};
  if(patch.manager_user_id){const {data:m}=await db.from("tour_managers").select("user_id").eq("user_id",patch.manager_user_id).eq("active",true).maybeSingle();if(!m)return json({error:"Select an active Tour Manager"},400);}
  let result;if(id){const {data,error}=await db.from("tour_journeys").update(patch).eq("id",id).select("*").single();if(error)return json({error:"Could not update tour"},500);result=data;}else{patch.created_by=user.id;const {data,error}=await db.from("tour_journeys").insert(patch).select("*").single();if(error)return json({error:"Could not create tour"},500);result=data;}
  return json({journey:result});
 }
 if(body.action==="admin_save_route_stop"){
  const {error:authError,user}=await authorizedUser(req,"admin");if(authError||!user)return json({error:authError||"Admin permission required"},403);
  const p=body.stop||{},journeyId=bounded(p.journey_id,60),name=bounded(p.stop_name,180);if(!journeyId||!name)return json({error:"Tour and stop name are required"},400);
  const patch:any={journey_id:journeyId,stop_name:name,stop_type:bounded(p.stop_type,40)||"other",address:bounded(p.address,400)||null,latitude:p.latitude!==""&&Number.isFinite(Number(p.latitude))?Number(p.latitude):null,longitude:p.longitude!==""&&Number.isFinite(Number(p.longitude))?Number(p.longitude):null,planned_time:p.planned_time||null,expected_minutes:p.expected_minutes!==""&&Number.isFinite(Number(p.expected_minutes))?Math.max(0,Math.min(1440,Number(p.expected_minutes))):null,public_message:bounded(p.public_message,1000)||null,stop_order:Math.max(1,Number(p.stop_order)||1),is_temporary:!!p.is_temporary,created_by:user.id};
  const {data,error}=await db.from("tour_journey_stops").insert(patch).select("*").single();if(error)return json({error:"Could not add stop"},500);return json({stop:data},201);
 }
 if(body.action==="manager_list_journeys"){
  const {error:authError,user}=await authorizedUser(req,"tour_manager");if(authError||!user)return json({error:authError||"Tour Manager permission required"},403);
  const {data,error}=await db.from("tour_journeys").select("*,tour_journey_stops(*)").eq("manager_user_id",user.id).order("travel_date",{ascending:true});
  if(error)return json({error:"Could not load assigned tours"},500);return json({journeys:data||[]});
 }
 if(body.action==="manager_add_stop"){
  const {error:authError,user}=await authorizedUser(req,"tour_manager");if(authError||!user)return json({error:authError||"Tour Manager permission required"},403);
  const p=body.stop||{},journeyId=bounded(p.journey_id,60),name=bounded(p.stop_name,180);
  const {data:journey}=await db.from("tour_journeys").select("id").eq("id",journeyId).eq("manager_user_id",user.id).maybeSingle();if(!journey)return json({error:"This tour is not assigned to your account"},403);if(!name)return json({error:"Stop name is required"},400);
  const {data:existing}=await db.from("tour_journey_stops").select("stop_order").eq("journey_id",journeyId).order("stop_order",{ascending:false}).limit(1);
  const patch:any={journey_id:journeyId,stop_name:name,stop_type:bounded(p.stop_type,40)||"tea_break",address:bounded(p.address,400)||null,latitude:p.latitude!==""&&Number.isFinite(Number(p.latitude))?Number(p.latitude):null,longitude:p.longitude!==""&&Number.isFinite(Number(p.longitude))?Number(p.longitude):null,expected_minutes:p.expected_minutes!==""&&Number.isFinite(Number(p.expected_minutes))?Math.max(0,Math.min(1440,Number(p.expected_minutes))):null,public_message:bounded(p.public_message,1000)||null,stop_order:(Number(existing?.[0]?.stop_order)||0)+1,is_temporary:true,created_by:user.id,status:"in_progress"};
  const {data:stop,error}=await db.from("tour_journey_stops").insert(patch).select("*").single();if(error)return json({error:"Could not publish stop"},500);
  await db.from("tour_journey_updates").insert({journey_id:journeyId,update_type:"stop_added",message:"Naya stop: "+name,created_by:user.id});return json({stop},201);
 }
 if(body.action==="manager_stop_status"){
  const {error:authError,user}=await authorizedUser(req,"tour_manager");if(authError||!user)return json({error:authError||"Tour Manager permission required"},403);
  const stopId=bounded(body.stop_id,60),status=bounded(body.status,30);if(!["upcoming","in_progress","reached","completed","skipped"].includes(status))return json({error:"Invalid stop status"},400);
  const {data:stop}=await db.from("tour_journey_stops").select("id,journey_id,stop_name").eq("id",stopId).maybeSingle();if(!stop)return json({error:"Stop not found"},404);
  const {data:journey}=await db.from("tour_journeys").select("id").eq("id",stop.journey_id).eq("manager_user_id",user.id).maybeSingle();if(!journey)return json({error:"This tour is not assigned to your account"},403);
  const now=new Date().toISOString(),patch:any={status};if(status==="reached")patch.reached_at=now;if(status==="completed")patch.departed_at=now;
  const {data,error}=await db.from("tour_journey_stops").update(patch).eq("id",stopId).select("*").single();if(error)return json({error:"Could not update stop"},500);
  await db.from("tour_journey_updates").insert({journey_id:stop.journey_id,update_type:"stop_status",message:stop.stop_name+" — "+status,created_by:user.id});return json({stop:data});
 }
 if(body.action==="manager_update_journey"){
  const {error:authError,user}=await authorizedUser(req,"tour_manager");if(authError||!user)return json({error:authError||"Tour Manager permission required"},403);
  const id=bounded(body.journey_id,60),status=bounded(body.status,30),message=bounded(body.message,1000);if(!["scheduled","in_progress","completed","cancelled"].includes(status))return json({error:"Invalid journey status"},400);
  const {data,error}=await db.from("tour_journeys").update({status,updated_at:new Date().toISOString()}).eq("id",id).eq("manager_user_id",user.id).select("id").maybeSingle();if(error||!data)return json({error:"Could not update assigned tour"},403);
  if(message)await db.from("tour_journey_updates").insert({journey_id:id,update_type:"journey",message,created_by:user.id});return json({ok:true});
 }
 if(body.action==="manager_update_location"){
  const {error:authError,user}=await authorizedUser(req,"tour_manager");if(authError||!user)return json({error:authError||"Tour Manager permission required"},403);
  const id=bounded(body.journey_id,60),latitude=Number(body.latitude),longitude=Number(body.longitude);if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180)return json({error:"Invalid GPS coordinates"},400);
  const {data:journey}=await db.from("tour_journeys").select("id").eq("id",id).eq("manager_user_id",user.id).maybeSingle();if(!journey)return json({error:"This tour is not assigned to your account"},403);
  const {error}=await db.from("tour_live_locations").upsert({journey_id:id,manager_user_id:user.id,latitude,longitude,accuracy_m:Number.isFinite(Number(body.accuracy_m))?Number(body.accuracy_m):null,updated_at:new Date().toISOString()},{onConflict:"journey_id"});if(error)return json({error:"Could not update GPS location"},500);return json({ok:true});
 }
 if(body.action==="manager_ticket_lookup"){
  const {error:authError,user}=await authorizedUser(req,"tour_manager");if(authError||!user)return json({error:authError||"Tour Manager permission required"},403);
  const journeyId=bounded(body.journey_id,60),ticket=bounded(body.ticket_number,80);const {data:journey}=await db.from("tour_journeys").select("id,package_slug,travel_date").eq("id",journeyId).eq("manager_user_id",user.id).maybeSingle();if(!journey)return json({error:"This tour is not assigned to your account"},403);
  const {data:b,error}=await db.from("bookings").select("id,ticket_number,booking_code,customer_name,passenger_details,pickup_point,ticket_status,package_slug,travel_date,fare_total,amount_received").eq("ticket_number",ticket).eq("ticket_status","issued").maybeSingle();if(error||!b)return json({error:"Issued ticket not found"},404);if((journey.package_slug&&b.package_slug!==journey.package_slug)||(journey.travel_date&&b.travel_date!==journey.travel_date))return json({error:"Yeh ticket is tour/date se sambandhit nahi hai."},403);
  const list=Array.isArray(b.passenger_details)&&b.passenger_details.length?b.passenger_details:[{name:b.customer_name}];const passengers=list.map((p:any,i:number)=>({name:bounded(p.name||p.full_name||p.passenger_name||(i===0?b.customer_name:"Yatri "+(i+1)),120),index:i+1}));
  const {data:attendance}=await db.from("tour_passenger_attendance").select("passenger_name,attendance_status").eq("journey_id",journeyId).eq("ticket_number",ticket);const statuses=new Map((attendance||[]).map((a:any)=>[a.passenger_name,a.attendance_status]));
  const {data:paidOrders}=await db.from("jktour24_payment_orders").select("amount_paise").eq("booking_id",b.id).eq("status","paid");const onlinePaid=Math.round((paidOrders||[]).reduce((sum:any,p:any)=>sum+(Number(p.amount_paise)||0),0)/100);
  return json({ticket:{id:b.id,ticket_number:b.ticket_number,booking_code:b.booking_code,pickup_point:b.pickup_point,fare_total:Number(b.fare_total)||0,amount_received:Number(b.amount_received)||0,online_paid_amount:onlinePaid,balance_due:Math.max(0,Number(b.fare_total||0)-Number(b.amount_received||0)),passengers:passengers.map((p:any)=>({...p,attendance_status:statuses.get(p.name)||"not_present"}))}});
 }
 if(body.action==="manager_mark_attendance"){
  const {error:authError,user}=await authorizedUser(req,"tour_manager");if(authError||!user)return json({error:authError||"Tour Manager permission required"},403);
  const journeyId=bounded(body.journey_id,60),ticket=bounded(body.ticket_number,80),passenger=bounded(body.passenger_name,120),status=body.present===true?"present":"not_present",pickup=bounded(body.pickup_point,180);
  const {data:journey}=await db.from("tour_journeys").select("id,package_slug,travel_date").eq("id",journeyId).eq("manager_user_id",user.id).maybeSingle();if(!journey)return json({error:"This tour is not assigned to your account"},403);
  const {data:booking}=await db.from("bookings").select("id,ticket_number,passenger_details,customer_name,package_slug,travel_date").eq("ticket_number",ticket).eq("ticket_status","issued").maybeSingle();if(!booking)return json({error:"Issued ticket not found"},404);if((journey.package_slug&&booking.package_slug!==journey.package_slug)||(journey.travel_date&&booking.travel_date!==journey.travel_date))return json({error:"Yeh ticket is tour/date se sambandhit nahi hai."},403);
  const valid=Array.isArray(booking.passenger_details)&&booking.passenger_details.length?booking.passenger_details.some((p:any,i:number)=>bounded(p.name||p.full_name||p.passenger_name||(i===0?booking.customer_name:"Yatri "+(i+1)),120)===passenger):bounded(booking.customer_name,120)===passenger;if(!valid)return json({error:"Passenger does not belong to this ticket"},400);
  const {error}=await db.from("tour_passenger_attendance").upsert({journey_id:journeyId,booking_id:booking.id,ticket_number:ticket,passenger_name:passenger,pickup_point:pickup||null,attendance_status:status,marked_by:user.id,marked_at:new Date().toISOString()},{onConflict:"journey_id,ticket_number,passenger_name"});if(error)return json({error:"Could not save attendance"},500);return json({ok:true,attendance_status:status});
 }
 if(body.action==="yatra_saathi_verify"){
  const ticket=bounded(body.ticket_number,80),mobile=String(body.mobile||"").replace(/[^0-9]/g,"");if(!ticket||mobile.length<10)return json({error:"Ticket number aur registered mobile number required hain"},400);
  const {data:b,error}=await db.from("bookings").select("id,ticket_number,booking_code,package_slug,package_name,customer_name,customer_mobile,travel_date,pickup_point,pickup_time,fare_total,ticket_status,passenger_details").eq("ticket_number",ticket).eq("ticket_status","issued").maybeSingle();
  if(error||!b||String(b.customer_mobile||"").replace(/\D/g,"").slice(-10)!==mobile.slice(-10))return json({error:"Ticket number aur registered mobile match nahi hue. Dono details check karein."},403);
  const {data:publishedJourney}=await db.from("tour_journeys").select("id,title,travel_date,bus_label,pickup_points,welcome_message,packing_list,status,manager_user_id,tour_managers(full_name,mobile,email,active),tour_journey_stops(*),tour_live_locations(*),tour_journey_updates(*)").eq("package_slug",b.package_slug).eq("travel_date",b.travel_date).maybeSingle();
  const journey=publishedJourney||{id:null,title:b.package_name||"Yatra details pending",travel_date:b.travel_date,bus_label:null,pickup_points:[],welcome_message:"Aapki ticket verify ho gayi hai. Route, bus location aur pickup ke live updates tour admin/manager ke publish karte hi yahan dikh jayenge.",packing_list:[],status:"pending_publish",manager_user_id:null,tour_managers:null,tour_journey_stops:[],tour_live_locations:[],tour_journey_updates:[]};
  const {data:attendance}=journey.id?await db.from("tour_passenger_attendance").select("passenger_name,attendance_status").eq("journey_id",journey.id).eq("ticket_number",ticket):{data:[]};return json({passenger:{name:b.customer_name,ticket_number:b.ticket_number,travel_date:b.travel_date,package_name:b.package_name,pickup_point:b.pickup_point,pickup_time:b.pickup_time},journey,attendance:attendance||[]});
 }
 return json({error:"Unknown action"},400);
});