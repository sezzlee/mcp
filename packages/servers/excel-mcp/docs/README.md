# Excel oluşturma ve düzenleme: araştırmaya dayalı faz planı

Status: K1-01–K1-09 remain recorded. Phase 0 provides the explicit writing mode, value contract and safe immutable output foundation. Phase 1 is implemented with evidence in its [implementation plan](phase-1/implementation-plan.md). Phase 2 value transfer is implemented; decisions, support boundaries and local acceptance evidence are recorded in the [Phase 2 plan](phase-2/implementation-plan.md). Phases 3 and later remain planned. Copying existing formulas and formatting is required in Phase 3 as F3-09.

## Hedef ve dayanak

Agent yeni Excel oluşturabilmeli, doğrudan verilen veya önceden okunan verilerle doldurabilmeli, konuşma boyunca düzenlemeye devam edebilmeli ve basitten uzman seviyesine kadar toplu işlemler yapabilmeli.

Bütün hedef ve fazlar birlikte değerlendirilir; kodlama bu plana göre faz faz yapılır. Belgeler Türkçedir. Kütüphane, motor ve araç adları ihtiyaçlar yerine geçmez; bu plan bunları peşinen seçmez.

Bu sürüm, [Haris ve Negokaz repo karşılaştırmasına](research/repository-comparison.md) dayanır. Rapor sabit commit kaynaklarını, iyi fikirleri, somut sorunları, tasarım tercihlerini ve incelemenin sınırlarını içerir.

## Kesinleşen ilkeler ve kararlar

| Kimlik | Karar                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1-01  | Çalışma interaktiftir; kullanıcı aynı çalışma kitabını konuşma boyunca geliştirir ve düzenler.                                                                                                                                                             |
| K1-02  | İhtiyaçlar insanın Excel'de yaptığı işlemlerden hareketle tanımlanır; bütün özelliklerin ayrıntıları kendiliğinden onaylanmış sayılmaz.                                                                                                                    |
| K1-03  | Agent açıkça tarif edilen değişikliği uygulayabilmeli; değişiklik kapsamındaki belirsizliği çözebilmeli.                                                                                                                                                   |
| K1-04  | Agent niyeti konuşma ve dosya bağlamında anlayabilmeli; kullanıcı her ayrıntıyı hücre adresleriyle tarif etmek zorunda kalmamalı.                                                                                                                          |
| K1-05  | Kaynak dosya korunur. Düzenleme yeni çıktı sürümü üretir; sonraki istek seçilen çıktı sürümünü kaynak alır.                                                                                                                                                |
| K1-06  | Önce formül yazma geliştirilir. Excel kurulmadan sunucuda formül hesaplama ayrı bir sonraki fazdır.                                                                                                                                                        |
| K1-07  | Aynı excel-mcp paketi kullanılır; varsayılan okuma davranışı korunur ve yazma ayrıca etkinleştirilen bir modda sunulur. Okuma ve çıktı yazma yetkileri ayrı kalır.                                                                                         |
| K1-08  | Hücre türünü agent bağlamdan belirleyip yazma aracına açıkça bildirir. Yazıcı bu türü uygular; metni görünümüne bakarak kendiliğinden tarihe veya formüle dönüştürmez. Kullanıcı tür seçmek zorunda değildir.                                              |
| K1-09  | Birlikte tek sonuç oluşturması gereken değişikliklerde bütünlük sağlanır: grubun tamamı başarılı olmadan tamamlanmış yeni çıktı sunulmaz. Bağımsız işlerde başarılı çıktılar sunulabilir; başarısız işler ve toplam işin kısmi başarısı açıkça belirtilir. |

Yeni dosya, doğrudan veri yazma, okunan veriyi aktarma, mevcut dosyayı düzenleme ve toplu işlemler genel hedefin parçalarıdır. Mevcut kod incelemesinde yeni .xlsx oluşturmak için bir Excel motoru alınmasını zorunlu kılan eksiklik görülmedi. Başlangıç önerisi, mevcut Node/OOXML ve ZIP temeli üzerine kendi yazma katmanımızı geliştirmektir. İki reponun motoru doğrudan alınmış değildir.

## Fazların bütünü

| Faz                                                  | Kazanılacak yetenek                                                                          | Kodlama sırası                                                                                                                 | Çıkış ölçütü                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [0. Yazma temeli](phase-0/README.md)                 | Mevcut altyapı üzerinde kaynak/çıktı/sürüm, tür, işlem sınırı, bütçe ve doğrulama kuralları. | Mevcut parçaları ve eksikleri ayır → değer/işlem sözleşmesini belirle → ayrı yazma yetkisini kur → kabul örnekleriyle doğrula. | Salt okunur güvenceler korunur; kaynağı değiştirmeden kontrollü çıktı üretme ve başarısızlık davranışı doğrulanabilir. |
| [1. Oluşturma ve temel yazma](phase-1/README.md)     | Yeni .xlsx, sayfalar, toplu yazma, basit ekleme ve değer düzeltme.                           | Oluşturma → değer yazma → yeni sürümle devam → sonuç kontrolü.                                                                 | Agent yeni dosya oluşturur, kayıt ekler, değer düzeltir; her çıktının kaynağı ve sonucu bellidir.                      |
| [2. Okunan veriyi aktarma](phase-2/README.md)        | Dosya/aralık, seçilmiş kayıt veya analiz sonucunu model tekrar yazmadan aktarma.             | Kaynağı ve seçimi belirle → tam veriyi taşı → hedefe yerleştir → değer ve kapsamı doğrula.                                     | İstenen veri doğru hedefe eksiksiz aktarılır; önizleme tüm veri sayılmaz.                                              |
| [3. Mevcut dosyayı düzenleme](phase-3/README.md)     | Hedefli değer değişikliği, temizleme, sayfa ve yapısal işlemler.                             | Önce koruma kapsamı ve hedefli değişiklikler → sonra satır/kolon/sayfa yapısı ve ilişkili referanslar.                         | Kaynak aynı kalır; yeni sürümde değişiklik doğrudur ve taahhüt edilen içerik korunur.                                  |
| [4. Gelişmiş toplu işlemler](phase-4/README.md)      | Koşullu güncelleme, liste yenileme, eşleştirme, sıralama, tekrar ve birleştirme.             | Veri anlamı → işlemler → çok adımlı iş ve yeniden deneme → büyük veri kontrolü.                                                | Kayıt kapsamı, çakışmalar ve işin tamamlanma sonucu açıktır.                                                           |
| [5. Biçim, tablo ve formül yazma](phase-5/README.md) | Okunabilir görünüm, Excel tabloları ve formül oluşturma/düzenleme.                           | Görünüm → tablo → formül ve başvurular → yeniden hesaplama durumu.                                                             | İstenen görünüm ve formüller bulunur; hesaplanmamış sonuç hesaplanmış gibi sunulmaz.                                   |
| [6. Sunucuda formül hesaplama](phase-6/README.md)    | Seçilmiş formül kapsamını Excel kurulmadan hesaplama.                                        | İşlev kapsamı → bağımlılıklar ve değer anlamı → hesaplama → bağımsız Excel sonuçlarıyla doğrulama.                             | Desteklenen kapsam doğrulanır; desteklenmeyen, döngüsel veya bütçeyi aşan hesaplamalar açıkça ayırt edilir.            |
| [7. Uzman iş akışları](phase-7/README.md)            | Grafik, özet tablo, doğrulama kuralları, şablon ve diğer seçilmiş ileri ihtiyaçlar.          | Yetenek ailelerini seç → özellik işlemleri → ilişkili veri değişiklikleri → gerçek rapor doğrulaması.                          | Seçilmiş uzman senaryolarında oluşturma/düzenleme/koruma/yenileme sonucu doğrulanır.                                   |

Her faz dosyasında ihtiyaçlar, kodlama iş paketleri, bağımlılıklar, sınırlar, kabul senaryoları ve açık kararlar bulunur. Hazırlık fazı ve hesaplama fazı repo incelemesiyle eklenmiştir; uzman özellikler eski Faz 6'dan Faz 7'ye taşınmıştır.

## Sıra ve bağımlılıklar

Önerilen ana sıra: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7.

- Faz 0, ilk yazma kodunun ve diğer fazların ortak sınırlarını netleştirir.
- Faz 1 yeni dosya temelidir; Faz 2 bu temeli mevcut okuma yatırımına bağlar.
- Faz 3, dışarıdan gelen dosyadaki özellikleri koruma yükünü ekler. Faz 2'nin önce gelmesi, mevcut dosya üzerinde karmaşık değişiklik gerektirmeden veri aktarımını kullanılabilir kılar.
- Faz 4 aktarım ve düzenlemeyi birden çok kaynak/hedef üzerinde birleştirir.
- Faz 5'in temel görünüm işleri, ihtiyaç görülürse Faz 1–2 sonrasına alınabilir. Türlerin doğru saklanması görünüm fazını beklemez.
- Faz 6, Faz 5'in formül yazmasına dayanır. Formül kapsamı ayrı yönetilir; bütün Excel işlevleri taahhüt edilmez.
- Faz 7'deki her aile aynı bağımlılığa sahip değildir. Basit grafik için hesaplama motorunun bitmesi şart olmayabilir; hesaplanmış sonuç gerektiren uzman işler ilgili hesaplama desteğine bağlıdır.

Bir özelliği oluşturmak ve var olanını korumak farklı ihtiyaçlardır. Faz 3'te satır siliniyorsa mevcut formüllerin, tabloların, adlandırılmış alanların ve grafik başvurularının etkisi o işlem eklenirken değerlendirilir. Bunları oluşturacağımız fazın ileride olması koruma ihtiyacını ertelemez.

## Bütün fazlarda geçerli ihtiyaçlar

Aşağıdaki maddeler, kesinleşen kararların ayrıntılarını tamamlayan ihtiyaç önerileridir.

| Kimlik | İhtiyaç                                                                                                                                                                                                                                                                  | Başlangıç                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| O-01   | Kaynak, kaynak sürümü, hedef ve hedef kapsamı anlaşılır olmalı. Benzer ad veya birden fazla eşleşme gizlenmemeli.                                                                                                                                                        | Faz 0–1; kayıt/koşul kapsamı Faz 3–4.      |
| O-02   | Yazma, düzeltme, ekleme, liste yenileme, içerik temizleme ve yapısal silme farklı niyetler olmalı.                                                                                                                                                                       | Faz 1, 3 ve 4.                             |
| O-03   | Metin, sayı, kimlik, tarih/saat, mantıksal değer, boş hücre, boş metin, formül ve hata değeri ayrımları tanımlanmalı.                                                                                                                                                    | Faz 0; tür desteği aşamalı.                |
| O-04   | Literal metin yalnızca görünümünden dolayı mecburen formüle veya tarihe dönüşmemeli; uzun kimlik ve baştaki sıfırlar korunabilmeli.                                                                                                                                      | Faz 0–1.                                   |
| O-05   | Kaynak dosya değişmeden yeni çıktı sürümü üretilmeli. Başarısız işlem kullanılabilir yeni sürüm gibi sunulmamalı.                                                                                                                                                        | Kesin karar K1-05; Faz 0–1.                |
| O-06   | Tek hücre yanında toplu işlem bulunmalı; hücre, dosya, açılmış içerik, bellek, süre, girdi ve yanıt bütçeleri ayrı değerlendirilmeli.                                                                                                                                    | Faz 0–1, her fazda genişler.               |
| O-07   | Yazma sonucunda bütün hücreleri tekrar döndürmek gerekmemeli. Kaynak/hedef, değişiklik kapsamı ve tamamlanma durumu için küçük sonuç yeterli olmalı.                                                                                                                     | Faz 1.                                     |
| O-08   | Tamamlanma sınırı K1-09'a göre belirlenir: birbirine bağlı değişiklik grubu bütünüyle başarılı olmalı; bağımsız işlerin kısmi başarısı açıkça bildirilebilir. Bir araç çağrısı ile kullanıcı işinin sınırı otomatik olarak aynı sayılmaz. Yanıt kaybı ayrıca ele alınır. | Temel sınır Faz 0; çok adımlı iş Faz 4.    |
| O-09   | Yeniden deneme ile bilinçli tekrar ayrılmalı; ekleme yeniden denendiğinde istenmeyen mükerrer kayıt oluşmamalı.                                                                                                                                                          | Faz 1; çoklu hedeflerde Faz 4.             |
| O-10   | Daha önce okunan kaynakla güncel kaynak ayrılmalı; kaynak değişikliği sessizce başka veriyle devam ettirmemeli.                                                                                                                                                          | Faz 0–2.                                   |
| O-11   | Desteklenen düzenlemelerde ilgisiz içerik korunmalı. Bilinmeyen veya korunamayan özellik görünür olmalı.                                                                                                                                                                 | Temel türler Faz 1; karmaşık koruma Faz 3. |
| O-12   | Agent'ın doğru niyeti/hedefi seçmesi ile işlemin doğru uygulanması ayrı değerlendirilmeli.                                                                                                                                                                               | Her faz.                                   |
| O-13   | İşlem geri alma, yeniden uygulama ve önceki sürüme dönme farklı ihtiyaçlar olmalı. Kaynağı korumak tek başına tüm geri alma davranışını tanımlamaz.                                                                                                                      | Sürüm temeli Faz 0–1; iş kapsamı Faz 3–4.  |
| O-14   | Oluşturma, düzenleme, koruma, hesaplama ve yenileme desteği her özellik için ayrı açıklanmalı.                                                                                                                                                                           | Faz 3 ve sonrası.                          |
| O-15   | Bağımsız örneklerle doğrulama bulunmalı. Dosyanın açılması, kayıt sayısının tutması veya yalnızca kendi okuyucumuzdan geçmesi tek başına yeterli sayılmamalı.                                                                                                            | Faz 0'dan itibaren.                        |

## Repo araştırmasından aldığımız yön

[Karşılaştırma raporunda](research/repository-comparison.md) kaynaklara bağlı ayrıntılar vardır.

- Haris'ten: küçük işlem sonucu, atomik kaydetme sınırı, korumayı ayrı ele alma, açık yapıştırma modları, kaynak bütçeleri ve gerçek Excel'den beklenen sonuç yaklaşımı.
- Negokaz'dan: dar başlangıç araç seti, yetenek/motor ayrımı ve görünümü ayrıca inceleme ihtiyacı.
- Aynen alınmaması önerilenler: kaynağı önce kısaltarak kaydetme, bütün yazılan veriyi yanıtta tekrar döndürme, tarih/formül niyetini yalnızca metin biçiminden çıkarma ve masaüstü Excel'e örtük geçiş.
- Doğrudan alınmış bir motor veya uygulama kodu yoktur. Faz 0'daki mevcut kod incelemesi, ZIP üretiminin mevcut bağımlılıkla karşılanabildiğini ve çalışma kitabı üretimi/güvenli çıktı tarafının eksik olduğunu gösterdi. Yeni Excel motoru seçmek başlangıç koşulu değildir.

## Mevcut salt okunur sunucuyla ilişki

[Paket README belgesi](../README.md) mevcut sunucuyu salt okunur tanımlar. [mcp-core](../../../cores/mcp-core/README.md) salt okunur araç kaydını sunucunun kendi çıktısını üreten araçlardan ayırır; [file-core](../../../cores/file-core/README.md) yazma yüzeyini dışarı açmaz.

Yazma eklemek bu sınırı sessizce genişletmemelidir. Kayıtlı araçların niteliği, yanıt bütçesi, sandbox dosya erişimi ve kaynak/çıktı ayrımı korunmalıdır. Kullanıcı kararıyla aynı pakette ayrıca etkinleştirilen yazma modu seçildi. Bu kararın kayıt, katman ve çıktı yetkisi ayrıntıları Faz 0 kapsamında tamamlanır; diğer salt okunur sunucuların yetkisi genişletilmez.

Mevcut okuyucu sayfalama, örnekleme, veri yorumlama ve analiz yapabilir; seçilmiş verinin tamamını yazma tarafına taşımak bunların kapsamını doğru anlamayı gerektirir. Okuyucu formülleri yeniden hesaplamaz; yeni hesaplama kapsamı ayrı Faz 6'dır.

## Açık kararlar ve uygulama zamanı

A-05 was resolved with the user on 2026-10-25: Phase 2 transfers values; Phase 3 must copy existing formulas and formatting. Changed sources require a new preparation, all matching records are transferred unless a subset is explicit, and replacing occupied targets requires explicit overwrite. See the [Phase 2 implementation plan](phase-2/implementation-plan.md).

Kullanıcının yanıtladığı kaynak koruma, ayrı hesaplama, aynı pakette ayrıca etkinleştirilen yazma modu, açık hücre türü ve bağlı/bağımsız işlerin tamamlanma ilkesi yeniden sorulmayacak. Aşağıdakiler uygulama ayrıntılarını ve kalan kapsamı gösterir.

| Kimlik | Karar alanı                                                                                                                                                                                                      | Ne zaman gerekli?                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A-01   | İlk biçim ve desteklenen türlerin kapsamı. .xlsx başlangıç önerisi. Türün agent tarafından açıkça seçilmesi ve literal metnin örtük dönüştürülmemesi K1-08 ile kesin; türlerin ayrıntılı anlamları tamamlanacak. | Faz 0–1.                                    |
| A-02   | Kaynak korunarak yeni çıktı üretmenin sürüm kimliği, devam ve başarısız çıktı davranışı.                                                                                                                         | Faz 0.                                      |
| A-03   | Aynı pakette ayrı yazma modu kararı kesin. Mevcut salt okunur sınırlarla kayıt ve çıktı yetkisi ayrıntıları tamamlanacak; yeni Excel motoru başlangıç şartı değil.                                               | Faz 0.                                      |
| A-04   | Temsili iş boyutları, ölçülmüş süre/bellek sınırları, giriş/yanıt ve çıktı bütçeleri.                                                                                                                            | Faz 0–1; her fazda yeniden değerlendirilir. |
| A-05   | Aktarımın kaynak sürümü, tam/alt küme, ham/yorumlanmış veri ve değer/formül/biçim kapsamı.                                                                                                                       | Faz 2.                                      |
| A-06   | Mevcut dosyada desteklenen biçim ve korunacak özellikler. Kaynağı değiştirmeme kararı kesindir.                                                                                                                  | Faz 3.                                      |
| A-07   | Yapısal değişiklikte formül, tablo, isim, grafik ve diğer bağlı içeriklerin destek sınırı.                                                                                                                       | İlgili Faz 3 işlemi eklenmeden önce.        |
| A-08   | Eşleşme, tekrar, boş değer, çakışma ve sıralama kuralları; K1-09'a göre iş gruplama, sonuç bildirimi ve yeniden deneme ayrıntıları. Bağlı işte bütünlük, bağımsız işte açık kısmi başarı ilkesi kesin.           | Faz 4.                                      |
| A-09   | Biçimler, tablo ve formül yazma kapsamı; hesaplanmamış sonucun gösterimi.                                                                                                                                        | Faz 5.                                      |
| A-10   | Uzman aileleri ve özellik başına okuma/oluşturma/düzenleme/koruma/yenileme desteği.                                                                                                                              | Faz 7.                                      |
| A-11   | Geri alma, yeniden uygulama ve çok adımlı işin geri alınabilir sınırı.                                                                                                                                           | Sürüm temeli Faz 0; işlemler Faz 3–4.       |
| A-12   | Hesaplama işlevleri, doğruluk beklentisi, hata/boş/tarih davranışları, bağımlılık ve kaynak sınırları. Ayrı faz olması kesin karardır.                                                                           | Faz 6.                                      |

## Ortak tamamlanma ölçütleri

- İstenen değişiklik doğru hedefte, doğru kapsamda gerçekleşir.
- Kaynak ve önceki sürüm korunur; yeni sürüm tamamlanmış çıktı olarak ayırt edilir.
- Desteklenen değerlerin anlamı ve fazın koruma taahhüdü karşılanır.
- İnteraktif devam, toplu işlem, hatalı girdi, başarısızlık ve yeniden deneme örnekleri doğrulanır.
- Birlikte tek sonuç üreten değişiklik grubu yarım tamamlanmış çıktı sunmaz. Bağımsız işlerde başarılı çıktılar korunur; başarısız işler ve toplam kısmi başarı açıkça bildirilir.
- İşlem gerçekleşip yanıt kaybolduğunda kullanıcıya ve agent'a yanlış tamamlanma bilgisi verilmez.
- Mevcut okuma ve sandbox güvenceleri gerilemez.
- Bağımsız beklenen sonuç ve gerekli paket/görünüm kontrolleri uygulanır.
- Desteklenen ve ertelenmiş özellikler belgeyle örtüşür.

## Kodlamaya başlangıç

İlk adım [Faz 0](phase-0/README.md): mevcut altyapı envanteri üzerinde kapsam kararlarını değer, işlem ve çıktı sözleşmesine dönüştürmek. Envanter, paket/mod kararı, açık tür sözleşmesi ve tek çıktı için güvenli sürüm hazırlama temeli uygulandı. İlk kullanıcıya görünür çalışan sonuç [Faz 1](phase-1/README.md) olacaktır.

All phases remain planned as a sequence. Phase 0–1 foundations and Phase 2 value transfer are implemented. The next development target is Phase 3's preservation contract and targeted editing, including the required copying of existing formulas and formatting; new formula/style authoring remains Phase 5.
