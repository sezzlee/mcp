# Faz 0: mevcut altyapı üzerinde yazma sözleşmesi

Durum: mevcut kod envanteri ve K1-01–K1-09 kararları üzerine kurulu Faz 0 uygulama planı. Kabul senaryoları kodlamanın hedefidir; uygulama sonucu olarak sunulmaz.

[Ana plan](README.md) ve [repo karşılaştırması](research/repository-comparison.md) bu belgenin bağlamıdır.

## Hedef

Mevcut Node, OOXML, dosya erişimi ve MCP altyapısını kullanarak yazma için eksik sözleşmeleri belirlemek. Yeni bir Excel motoru veya kütüphanesi seçmek bu fazın zorunlu başlangıcı değildir.

Faz 1'de yeni .xlsx oluşturma ve temel değer yazma için yeni bir Excel motorunu zorunlu kılan eksiklik saptanmadı. Mevcut bağımlılık ZIP üretimini de karşılıyor; Excel parçalarını üretme ve güvenli çıktı yayımlama tarafı geliştirilecek. Bu bulgu, bütün uzman özelliklerin veya hesaplamanın aynı şekilde karşılanacağını kanıtlamaz.

## Kesin kararların karşılığı

- Kaynak dosya ve önceki çıktı sürümleri korunur; başarılı düzenleme yeni sürüm üretir.
- Sonraki istek seçilen çıktı sürümünü kaynak alır.
- Formül yazma ile sunucuda hesaplama ayrı fazlardır.
- Aynı excel-mcp paketi kullanılır. Varsayılan okuma davranışı korunur; yazma ayrıca etkinleştirilir.
- Okuma ve çıktı yazma yetkileri, aynı pakette olsalar da ayrı kalır.
- Hücre türünü agent bağlamdan belirler ve yazma aracına açıkça bildirir. Yazıcı bu türü uygular; metinden kendiliğinden tarih veya formül çıkarmaz.
- Birlikte tek sonuç oluşturacak değişiklikler bütünüyle tamamlanır; bağımsız işlerde başarılı çıktılar sunulabilir ve kısmi başarı açıkça belirtilir.

Bu kararlar ana belgedeki K1-01–K1-09 ile birlikte ele alınır. Yazma modu `sezzlee-excel <workbook-root> --write <relative-output-directory>` biçiminde ayrıca etkinleştirilir; çıktı dizini önceden mevcut olmalıdır.

## Kodlamadan önceki envanter

| Alan                 | Mevcut yetenek                                                                                                                                   | Yazma açısından anlamı                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| ZIP altyapısı        | ooxml-core mevcut fflate bağımlılığıyla ZIP okuyor. Kurulu 0.8.3 sürümünün tür tanımlarında ZIP oluşturma ve akışlı ZIP üretme yüzeyleri de var. | ZIP üretmek için yeni bir bağımlılık zorunlu görünmüyor.                                             |
| OOXML paket okuma    | Parçalar, ham parça baytları, içerik türleri ve ilişkiler okunabiliyor.                                                                          | Kaynağı ve değişiklikten etkilenmeyen içeriği inceleme temeli var.                                   |
| Excel'e özgü okuma   | Çalışma kitabı, sayfa-parça eşleştirmesi, tarih sistemi, hücreler ve biçimler okunuyor.                                                          | Bu bilgiler yeniden kullanılabilir; henüz çalışma kitabı yazıcısı değiller.                          |
| XML işleme           | Namespace bilgisiyle XML okuma ve ayrıştırma var.                                                                                                | XML üretme, doğru metin kaçışları ve çalışma kitabı parçalarını yazma ek iş.                         |
| Kaynak erişimi       | NativeRoot çözümleme, sınırlı okuma, özet alma ve tarama sağlıyor.                                                                               | Kaynak okumayı yeniden yazmak gerekmiyor; dışa açık bir çıktı yazma yeteneği şu anda yok.            |
| MCP sözleşmesi       | mcp-core salt okunur araç ile sunucunun yalnızca kendi çıktısını üretmesini ayırıyor.                                                            | Yeni sürüm üretme yönüyle uyumlu bir başlangıç var; kaydı ve uygulama sınırı ayrıca düzenlenecek.    |
| Salt okunur kayıt    | file-core yazma yüzeyini dışarı açmıyor; excel-mcp şu anda salt okunur sunucu kuruyor.                                                           | Yazma etkinleşince gerekli yüzey açıkça seçilmeli; diğer okuma sunucuları sessizce genişletilmemeli. |
| Yanıt bütçesi        | Ortak hata/yanıt sınırı ve strict girdi doğrulaması mevcut.                                                                                      | Bunları kopyalamak yerine yazma yüzeyinde de kullanma yönü değerlendirilebilir.                      |
| Sunum ve veri ayrımı | Okuma sunumu uzun metni kısaltabiliyor; ham/sorgulanabilir değer ayrı tutuluyor.                                                                 | Agent'a gösterilen sonucu geri yazarak tam veri aktarımı yapılamaz; kaynak değer kullanılmalı.       |

Kaynaklar: [OOXML yüzeyi](../../../cores/ooxml-core/src/reader.ts), [paket modeli](../../../cores/ooxml-core/src/model/package.ts), [ZIP bağımlılığı](../../../cores/ooxml-core/package.json), [Excel paket bilgisi](../src/metadata/spreadsheetml/package.ts), [native erişim yüzeyi](../../../cores/file-core-native/index.d.ts), [araç sözleşmeleri](../../../cores/mcp-core/src/tools.ts), [mevcut Excel sunucusu](../src/server.ts), [okuma sunumu](../src/grid/cell-value.ts).

Kurulu ZIP bağımlılığının yazma yüzeyinin bulunması bir performans veya uyumluluk testi değildir. Sıkıştırma seçimi ve bellek sınırları uygulamada ayrıca doğrulanacak.

## Mevcut temel üzerine önerilen iş ayrımı

1. Ortak ZIP/OPC işleri format bağımsız kalır; Excel hücresi, sayfası veya formülü ortak OOXML katmanına taşınmaz.
2. Excel'e özgü çalışma kitabı, sayfa ve hücre üretimi Excel paketinin sorumluluğudur.
3. Kaynak okuma ve yeni çıktı yayımlama ayrı dosya yetkileridir. Mevcut native okuma güvenceleri korunur.
4. NativeRoot'ta yazma metodu bulunmaması, kaynakları sıradan yol tabanlı erişimle açmak için gerekçe değildir. Güvenli çıktı yeteneğinin nerede uygulanacağı ayrıca netleştirilir.
5. Agent'ın gördüğü grid/sunum, çalışma kitabının tamamının kayıpsız yazılabilir modeli sayılmaz. Mevcut dosyayı düzenlerken özgün paket bilgisi korunur.
6. Haris veya Negokaz'ın motorunu bağlamak başlangıç varsayımı değildir; bu projeler davranış ve doğrulama referansıdır.

Bu ayrım sorumluluk sınırını tarif eder. Yeni dosya/klasör adları, araç adları ve bütün uygulama tipleri bu aşamada sabitlenmez.

## Değer sözleşmesi: kesin ilke ve kapsam önerisi

Kesinleşen ilke K1-08: Agent niyeti bağlamdan anlar; yazma tarafına seçtiği hücre türünü açıkça iletir. Yazıcı bu türü uygular ve metinden yeni bir niyet tahmin etmez. Kullanıcı tür seçmek zorunda değildir.

Aşağıdaki tür kapsamı ve ayrıntılı davranışlar öneridir; açık tür seçimi kararı bütün türlerin ilk sürümde destekleneceği anlamına gelmez.

| Durum                       | Önerilen anlam                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Metin                       | Literal olarak yazılır. = ile başlaması veya tarih gibi görünmesi tek başına türünü değiştirmez. |
| Sayı                        | Sayı olarak yazılır; numara gibi görünen kimliklerin metin niyetini ortadan kaldırmaz.           |
| Mantıksal değer             | Metin olan doğru/yanlış ifadesinden ayrı tutulur.                                                |
| Boş hücre                   | Açıkça hücreyi boşaltma niyetidir.                                                               |
| Boş metin                   | Metin değeridir; boş hücreyle aynı varsayılmaz.                                                  |
| Tarih ve tarih-saat         | Metinden ayrı niyettir; tarih sistemi ve saat anlamı belirlenmeden örtük dönüşüm yapılmaz.       |
| Verilmeyen güncelleme alanı | Mevcut değeri değiştirmez; boşaltma isteği sayılmaz.                                             |
| Formül                      | Ayrı niyettir. Formül yazma Faz 5, sunucuda hesaplama Faz 6 kapsamındadır.                       |

Başlangıçta metin, sayı, mantıksal değer, boş ve tarih/tarih-saat desteği önerilir. Özel hata değerleri, zengin bağlantılı veriler, hücre içi görseller ve diğer ileri türler okunabiliyor diye ilk yazma kapsamına kendiliğinden girmez.

Bu tablo belirli bir JSON biçimi veya araç imzası seçmez. Amaç, veri anlamını tek kaynakta tanımlamak ve doğrulamayla araç açıklamasının birbirine aykırı olmamasını sağlamaktır.

## İşlem ve çıktı sözleşmesi

Kesinleşen ilke K1-09: Birlikte tek sonuç oluşturması gereken değişikliklerde bütünlük; bağımsız işlerde açıkça belirtilen kısmi başarı.

- Bağlı iş örneği: Bir rapor için Giderler, Gelirler ve Özet sayfalarının birlikte hazırlanması. Özet adımı başarısızsa bu grup tamamlanmış yeni rapor olarak sunulmaz; önceki sürüm korunur.
- Bağımsız iş örneği: On ayrı rapordan dokuzunun hazırlanması. Dokuz başarılı çıktı sunulabilir; başarısız rapor ve toplam işin kısmen tamamlandığı açıkça belirtilir.

İş grubu yalnızca dosya sayısına veya araç çağrısı sayısına bakılarak belirlenmez; amaçlanan sonuç ve değişikliklerin bağımlılıkları esas alınır. Bunun nasıl ifade edileceği uygulama sözleşmesinde netleştirilir. Aşağıdaki diğer ayrıntılar öneridir.

- Her yazma isteğinin kaynağı, hedefi ve yapacağı değişiklik açık olmalı.
- İlgili girdi ve hedef koşulları, tamamlanmış çıktı yayımlanmadan denetlenmeli.
- Başarıda yeni sürüm ve küçük değişiklik sonucu döndürülmeli; tüm hücreler yanıtta tekrar edilmemeli.
- Başarısızlıkta kaynak ve önceki sürüm korunmalı. Oluşmuş olabilecek yarım dosya tamamlanmış sürüm olarak gösterilmemeli.
- Sonraki istek en son olduğu varsayılan bir dosyaya değil, seçilen sürüme dayanmalı.
- Aynı eski sürüm üzerinde iki farklı işlem yapılması sessizce birbirinin değişikliğini ezmemeli.
- Bir çağrı ile birden fazla çağrıdan oluşan iş farklı tamamlanma sınırlarıdır. K1-09'un bütünlük beklentisi ilgili iş grubuna aittir; tek bir dosyanın güvenli kaydedilmesi bunu kendiliğinden sağlamaz.
- Bağımsız işler kısmen tamamlanırsa hangi çıktıların hazır, hangi işlerin başarısız olduğu ayırt edilir; tüm iş tamamlandı denmez.
- Kaydetme tamamlanıp yanıt kaybolursa yeniden denemenin davranışı tanımlanmalı.

Mevcut own-output sözleşmesi oluşturma odaklıdır ve kendiliğinden idempotent olduğunu iddia etmez. Sadece yeni ad üretmek yeniden deneme ihtiyacını çözmez; sürüm/işlem ilişkisi ve tekrar davranışı ayrıca kararlaştırılır.

## Bütçeler için başlangıç yönü

Mevcut sınırlar başlangıç kanıtıdır; doğrudan tüm yazma sınırları olarak kopyalanmaz.

- Ortak MCP yanıt sınırı korunur; yazma sonucu küçük tutulur.
- Okuma sayfasının hücre sınırı, yazılabilir toplam dosya boyutu veya aktarım kapsamı değildir.
- İlk çıktılar, kendi okuyucumuzun dosya ve paket limitleri içinde tekrar açılabilmeli.
- Sıkıştırılmış boyut yanında parça boyutu, açılmış toplam, parça sayısı ve genişleme oranı da dikkate alınmalı.
- Tek isteğin girdi büyüklüğü, işlemde dokunulan hücreler, bellek, süre ve çıktı boyutu ayrı ölçülmeli.
- Büyük dosyada küçük değişiklik ile sıfırdan büyük dosya üretme aynı iş yükü sayılmamalı.

Sayısal yazma limitleri henüz belirlenmedi. Önerilen doğrulama örnekleri küçük dosya, binlerce satırlık blok ve büyük dosyada sınırlı değişikliktir; bunlar ölçülmüş kapasite vaadi değildir.

Kaynaklar: [Excel sınırları](../src/platform/limits.ts), [OOXML sınırları](../../../cores/ooxml-core/src/limits.ts), [ortak yanıt sınırı](../../../cores/mcp-core/src/limits.ts).

## Kodlama iş paketleri

1. Kesinleşen aynı-paket/ayrı-mod kararını, mevcut salt okunur yüzeyi genişletmeden uygulanabilir kayıt ve katman sınırına dönüştürmek.
2. Kaynak/sürüm, değer, işlem sonucu ve hata sözleşmelerini tek kaynakta tanımlamak.
3. Güvenli yeni çıktı yayımlama yeteneğini ve başarısızlık/yeniden deneme davranışını tamamlamak.
4. Mevcut ZIP temelini kullanarak Faz 1'in çalışma kitabı üretimini hazırlamak; Excel'e özgü üretimi kendi katmanında tutmak.
5. Bağımsız kabul örnekleri ve ölçülebilir bütçelerle bu temeli doğrulamak.

Bu iş paketleri Faz 0 uygulamasının kapsamıdır. Excel parçalarını sıfırdan üretme ve hücrelere veri yazma Faz 1 kapsamındadır.

## Bağımlılıklar ve sınırlar

- Yeni Excel motoru almak ilk koşul değildir; ileride somut ihtiyaç doğarsa ayrıca değerlendirilir.
- Mevcut okuyucunun ilişkiler, ham değer, kaynak erişimi ve bütçe güvenceleri yeniden kullanılır.
- Mevcut okuma yetkisinin yazma yetkisine dönüşmesi veya diğer kaynak sunucularına yayılması amaçlanmaz.
- İleri özelliklerin kayıpsız düzenlenmesi, temel .xlsx oluşturma yeteneğinden çıkarılamaz.
- Kaynağı koruma kararı, yeni çıktının doğru veya kayıpsız olduğunun kanıtı değildir.

## Kabul senaryoları

- Varsayılan mod yalnızca mevcut okuma yeteneklerini sunar; yazma ayrıca etkinleştirilir.
- Başarılı işlem yeni çıktı verir; kaynak ve önceki sürüm değişmez.
- Hatalı bir toplu girdi veya kaydetme hatası, ilgili değişiklik grubundan tamamlanmış çıktı üretmez.
- Bağlı raporun son adımı başarısızsa grubun yarım sonucu tamamlanmış sürüm olarak sunulmaz.
- On bağımsız işten biri başarısızsa dokuz başarılı çıktı sunulabilir; başarısız iş ve toplam kısmi başarı açıkça bildirilir.
- Literal = metni, başında sıfır olan kimlik, boş metin ve tarih görünümlü metin amaçlanan anlamı korur.
- Uzun metin agent'a kısaltılmış gösterilse bile aktarımın kaynak verisi kısalmaz.
- Sonraki işlem seçilen sürümü kullanır; arada değişen kaynak ve yanıt kaybı belirlenen davranışı verir.
- Üretilen .xlsx, mevcut paket sınırları içinde yeniden açılır; bağımsız paket/içerik kontrolüyle de doğrulanır.
- Kaynak ve çıktı dosya yetkileri ile yanıt bütçeleri gerçek işlem sırasında uygulanır.

Bu senaryolar Faz 0 için hedeflenen kabul ölçütleridir. Literal değerlerin gerçek Excel hücresine yazılması Faz 1'de; bağlı/bağımsız çok adımlı iş örneklerinin yürütülmesi Faz 4'te doğrulanacaktır.

## Açık kararlar

A-03'ün aynı paket/ayrı mod kaydı ve güvenli çıktı yetkisi bu fazda uygulanacak. A-01'in hücre kodlama ayrıntıları ve A-04'ün genel yazma ölçeği Faz 1'de; A-02 ve A-11'in genel değişiklik işi/geri alma ayrıntıları sonraki fazlarda genişletilecek. K1-09'un iş bütünlüğü ilkesi kesindir; iş gruplama ve sonuç ayrıntıları bu fazda tanımlanıp Faz 4'te genişletilir. Faz 6'nın hesaplama yaklaşımı bu fazda seçilmez.

## Çıkış ölçütü

Faz 1'in hangi kaynak/sürüm üzerinde, hangi değer ve işlem anlamıyla, hangi çıktı yetkisi ve bütçeyle çalışacağı nettir. Ortak yazma temeli uygulandığında yukarıdaki senaryolarla doğrulanır. Yalnızca mevcut altyapının bulunmuş olması Faz 0'ın bütün uygulama işlerinin tamamlandığı anlamına gelmez.
